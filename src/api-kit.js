import path from "node:path";
import express from "express";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { Op } from "seq";
import { validateConfig } from "./config/config-validator.js";
import { loadModules } from "./config/config-loader.js";
import { normalizeModules } from "./config/config-normalizer.js";
import { RouteRegistry } from "./openapi/route-registry.js";
import { buildOpenApiDocument } from "./openapi/openapi-builder.js";
import { loadModels } from "./loaders/model-loader.js";
import { loadModule } from "./loaders/module-loader.js";
import { runWithContext } from "./context/request-context.js";
import { getContext } from "./context/request-context.js";
import { errorHandler } from "./http/error-handler.js";
import { ok } from "./http/response.js";
import { ValidationError } from "./errors/validation-error.js";

export async function createApiKit(conf = {}) {
  const auditEvents = new EventEmitter();
  const config = {
    seq: conf.seq,
    baseDir: conf.baseDir || process.cwd(),
    basePath: conf.basePath || "",
    models: conf.models || {},
    modules: conf.modules || [],
    paths: {
      models: conf.paths?.models || "./models",
      services: conf.paths?.services || "./services",
      routers: conf.paths?.routers || "./routers",
      schemas: conf.paths?.schemas || "./schemas",
    },
    iam: conf.iam || null,
    audit: normalizeAuditConfig(conf.audit),
    openapi: conf.openapi ?? null,
    sse: conf.sse || { enabled: false },
  };
  if (config.audit) config.audit.events = auditEvents;

  validateConfig(config);

  const resolvedPaths = {
    models: path.resolve(config.baseDir, config.paths.models),
    services: path.resolve(config.baseDir, config.paths.services),
    routers: path.resolve(config.baseDir, config.paths.routers),
    schemas: path.resolve(config.baseDir, config.paths.schemas),
  };

  const rawModuleConfigs = await loadModules(config.modules, config.baseDir);
  const moduleConfigs = normalizeModules(rawModuleConfigs, { basePath: config.basePath });
  installAuditHooks(moduleConfigs, config.audit);

  const explicitModels = { ...config.models };
  for (const moduleConfig of moduleConfigs) {
    const resourceModel = moduleConfig.resource?.model;
    const modelName = resourceModel?.modelName || moduleConfig.resource?.options?.modelName || moduleConfig.resource?.model?.name;
    if (modelName && !explicitModels[modelName]) explicitModels[modelName] = resourceModel;
  }

  const modelsMap = await loadModels({seq: config.seq, explicitModels, modelsDir: resolvedPaths.models,moduleConfigs});
  registerSeqModels(config.seq, modelsMap.values());

  const routeRegistry = new RouteRegistry();
  const modules = new Map();
  const services = new Map();
  const models = new Map();
  const schemas = new Map();

  for (const mod of modelsMap) models.set(mod[0], mod[1]);

  for (const moduleConfig of moduleConfigs) {
    const mod = await loadModule({
      moduleConfig,
      seq: config.seq,
      modelsMap,
      routeRegistry,
      paths: resolvedPaths,
    });

    modules.set(moduleConfig.name, mod);
    services.set(moduleConfig.name, mod.service);
    schemas.set(moduleConfig.name, mod.schemas);
    if (mod.model) models.set(moduleConfig.name, mod.model);
  }

  const mainRouter = express.Router();
  const packageInfo = await loadPackageInfo(config.baseDir);
  const openapi = normalizeOpenApiConfig(config.openapi);

  mainRouter.use(runWithContext);

  for (const mod of modules.values()) mainRouter.use(mod.mount());
  installAuditChangesRoute({ mainRouter, routeRegistry, modules, models, config });
  installAuditSseRoute({ mainRouter, routeRegistry, modules, models, config });
  if (openapi) {
    mainRouter.get(joinPaths(config.basePath, openapi.path || "/openapi.json"), (_req, res) => {
      res.json(buildOpenApiDocument({ routes: routeRegistry, modules, packageInfo, config: openapi }));
    });
  }

  mainRouter.use(errorHandler);

  return {router: mainRouter, errorHandler, modules, models, services, routes: routeRegistry, schemas, events: auditEvents, close: async () => { auditEvents.removeAllListeners(); },
  };
}

function installAuditChangesRoute({ mainRouter, routeRegistry, modules, models, config }) {
  installAuditRoute({ mainRouter, routeRegistry, modules, models, config }, {
    path: config.audit?.changesPath,
    operationId: "audit.changes",
    serviceMethod: "changes",
    summary: "Cambios desde una fecha",
    handler: ({ AuditModel }) => async (req, res) => {
      const since = parseSince(req.query?.since);
      const sinceField = auditSinceField(AuditModel);
      const rows = await AuditModel.findAll({where: { [sinceField]: { [Op.gte]: since } }, order: [["id", "ASC"]],});
      res.json(ok(rows.map((row) => row.toJSON())));
    },
  });
}

function installAuditSseRoute({ mainRouter, routeRegistry, modules, models, config }) {
  installAuditRoute({ mainRouter, routeRegistry, modules, models, config }, {
    path: config.audit?.ssePath,
    operationId: "audit.sse",
    serviceMethod: "sse",
    summary: "Cambios en vivo",
    handler: ({ config }) => (req, res) => {
      res.writeHead(200, {"Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive"});
      res.write(": connected\n\n");

      const sendChange = (change) => res.write(`event: audit\ndata: ${JSON.stringify(change)}\n\n`);
      config.audit.events.on("change", sendChange);

      const heartbeat = setInterval(() => {res.write(": heartbeat\n\n")}, 30000);
      heartbeat.unref?.();

      req.on("close", () => {
        clearInterval(heartbeat);
        config.audit.events.off("change", sendChange);
      });
    },
  });
}

function installAuditRoute({ mainRouter, routeRegistry, modules, models, config }, { path, operationId, serviceMethod, summary, handler }) {
  if (!config.audit || !path) return;

  const AuditModel = findAuditModel(modules, models);
  if (!AuditModel) return;

  const fullPath = joinPaths(config.basePath, path);
  routeRegistry.register({
    module: "audit",
    operationId,
    method: "get",
    expressPath: fullPath,
    openApiPath: fullPath,
    serviceMethod,
    auth: { required: false, strategies: [] },
    permissions: [],
    summary,
    description: "",
    tags: ["audit"],
    deprecated: false,
  });

  const routeHandler = handler({ AuditModel, config });
  mainRouter.get(fullPath, (req, res, next) => {
    Promise.resolve(routeHandler(req, res, next)).catch(next);
  });
}

function findAuditModel(modules, models) {
  for (const mod of modules.values()) {
    if (isAuditTableName(mod.config?.name) || isAuditTableName(mod.config?.resource?.options?.tableName)) return mod.model;
  }
  return models.get("audit") || null;
}

function parseSince(value) {
  if (!value) throw new ValidationError("Parametro since requerido", { errors: { since: "Requerido" } });
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new ValidationError("Parametro since invalido", { errors: { since: "Fecha invalida" } });
  return date;
}

function auditSinceField(AuditModel) {
  return AuditModel?.options?.createdAt || "createdAt";
}

function registerSeqModels(seq, modelClasses) {
  if (!seq || !Array.isArray(seq._modelClasses)) return;

  for (const modelClass of new Set(modelClasses)) {
    if (!modelClass || seq._modelClasses.includes(modelClass)) continue;
    seq._modelClasses.push(modelClass);
  }
}

function installAuditHooks(moduleConfigs, auditConfig) {
  if (!auditConfig) return;

  const auditModule = moduleConfigs.find((moduleConfig) => isAuditModule(moduleConfig));
  const AuditModel = auditModule?.resource?.model;
  if (!AuditModel) return;

  for (const moduleConfig of moduleConfigs) {
    if (moduleConfig.audit === false || isAuditModule(moduleConfig)) continue;
    const resource = moduleConfig.resource;
    if (!resource?.model || !resource.options) continue;

    const hooks = { ...(resource.options.hooks || {}) };
    const previousData = new WeakMap();

    appendHook(hooks, "beforeUpdate", function beforeAuditUpdate(payload) {
      if (isModelInstance(payload)) previousData.set(payload, snapshot(payload));
    });
    appendHook(hooks, "beforeDestroy", function beforeAuditDestroy(payload) {
      if (isModelInstance(payload)) previousData.set(payload, snapshot(payload));
    });
    appendHook(hooks, "afterCreate", async function auditCreate(payload) {
      await writeAudit(AuditModel, auditConfig, this, "create", payload, {}, snapshot(payload));
    });
    appendHook(hooks, "afterUpdate", async function auditUpdate(payload, options = {}) {
      if (Array.isArray(payload)) {
        for (const model of payload) await writeAudit(AuditModel, auditConfig, this, "bulk-update", model, options.where || {}, snapshot(model));
        return;
      }
      await writeAudit(AuditModel, auditConfig, this, "update", payload, options.auditOld || previousData.get(payload) || {}, snapshot(payload));
    });
    appendHook(hooks, "afterDestroy", async function auditDestroy(payload, options = {}) {
      if (isModelInstance(payload)) {
        await writeAudit(AuditModel, auditConfig, this, "delete", payload, options.auditOld || previousData.get(payload) || snapshot(payload), {});
        return;
      }
      await writeAudit(AuditModel, auditConfig, this, "bulk-delete", null, options.where || {}, {});
    });
    appendHook(hooks, "afterBulkCreate", async function auditBulkCreate(models) {
      for (const model of models || []) await writeAudit(AuditModel, auditConfig, this, "bulk-create", model, {}, snapshot(model));
    });

    resource.options.hooks = hooks;
  }
}

function appendHook(hooks, name, hook) {
  const existing = hooks[name];
  if (!existing) {
    hooks[name] = [hook];
  } else if (Array.isArray(existing)) {
    hooks[name] = [...existing, hook];
  } else {
    hooks[name] = [existing, hook];
  }
}

async function writeAudit(AuditModel, auditConfig, ModelClass, action, model, oldData, newData) {
  const tableName = tableNameFor(ModelClass);
  if (!tableName || isAuditTableName(tableName)) return;

  const ctx = getContext() || {};
  const audit = ctx.audit || {};
  const auditRow = await AuditModel.create(
    {
      txId: ctx.txId || "",
      clientIp: audit.clientIp || audit.ip || "",
      userId: audit.userId || audit.usuarioId || null,
      tableName,
      rowId: rowId(model) || rowIdFromWhere(oldData),
      action,
      old: jsonSafe(oldData || {}),
      new: jsonSafe(newData || {}),
    },
    { hooks: false },
  );
  auditConfig?.events?.emit("change", auditRow.toJSON());
}

function isModelInstance(value) {
  return value && typeof value === "object" && value.dataValues && value.constructor;
}

function snapshot(model) {
  if (!model?.dataValues) return {};
  return jsonSafe(model.dataValues);
}

function rowId(model) {
  if (!model?.dataValues) return "";
  const pk = model.constructor?.primaryKeyAttribute;
  if (pk && model.dataValues[pk] !== undefined && model.dataValues[pk] !== null) return String(model.dataValues[pk]);
  if (model.dataValues.id !== undefined && model.dataValues.id !== null) return String(model.dataValues.id);
  return "";
}

function rowIdFromWhere(where = {}) {
  if (where.id !== undefined && where.id !== null) return String(where.id);
  return Object.values(where).filter((value) => value !== undefined && value !== null).join("_");
}

function tableNameFor(ModelClass) {
  return ModelClass?._resolvedTableName || ModelClass?.tableName || ModelClass?.modelName || ModelClass?.name || "";
}

function isAuditModule(moduleConfig) {
  return isAuditTableName(moduleConfig?.name) || isAuditTableName(moduleConfig?.resource?.options?.tableName) || isAuditTableName(moduleConfig?.resource?.options?.modelName);
}

function isAuditTableName(name) {
  return String(name || "").toLowerCase() === "audit";
}

function jsonSafe(value) {
  if (!value || typeof value !== "object") return {};
  return JSON.parse(JSON.stringify(value));
}

async function loadPackageInfo(baseDir) {
  try {
    return JSON.parse(await readFile(path.resolve(baseDir, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

function normalizeOpenApiConfig(openapi) {
  if (!openapi) return null;
  if (openapi === true) return {};
  return openapi;
}

function normalizeAuditConfig(audit) {
  if (!audit) return false;
  if (audit === true) return { changesPath: "/changes", ssePath: "/sse" };
  return { changesPath: "/changes", ssePath: "/sse", ...audit };
}

function joinPaths(...parts) {
  const clean = parts.filter((part) => part !== undefined && part !== null && part !== "").map((part) => String(part).trim()).filter(Boolean);
  const joined = clean.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  return `/${joined}`;
}
