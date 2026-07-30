import { Op } from "seq";
import { can as iamCan } from "iam/express";
import { getContext } from "../context/request-context.js";
import { ValidationError } from "../errors/validation-error.js";
import { ok } from "../http/response.js";
import { joinPaths } from "../utils/paths.js";

export function normalizeAuditConfig(audit) {
  if (!audit) return false;
  const defaults = { changesPath: "/changes", ssePath: "/sse", heartbeatTimeout: 15000 };
  if (audit === true) return defaults;
  return { ...defaults, ...audit, heartbeatTimeout: normalizeAuditHeartbeatTimeout(audit.heartbeatTimeout, defaults.heartbeatTimeout) };
}

export function installAuditHooks(moduleConfigs, auditConfig) {
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

export function installAuthAuditHooks(authContext, moduleConfigs, auditConfig) {
  if (!authContext || !auditConfig) return;

  const auditModule = moduleConfigs.find((moduleConfig) => isAuditModule(moduleConfig));
  const AuditModel = auditModule?.resource?.model;
  const SessionModel = authContext.models?.Session;
  if (!AuditModel || !SessionModel?.addHook) return;

  SessionModel.addHook("afterCreate", async function auditSessionCreate(payload) {
    await writeAudit(AuditModel, auditConfig, this, "create", payload, {}, snapshot(payload), { emit: false });
  });

  SessionModel.addHook("afterUpdate", async function auditSessionUpdate(payload, options = {}) {
    await writeAudit(AuditModel, auditConfig, this, "update", payload, options.auditOld || {}, snapshot(payload), { emit: false });
  });
}

export function installAuditChangesRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }) {
  installAuditRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }, {
    path: config.audit?.changesPath,
    operationId: "audit.changes",
    serviceMethod: "changes",
    summary: "Cambios desde una fecha",
    handler: ({ AuditModel, modules, routeRegistry, authContext }) => async (req, res) => {
      const since = parseSince(req.query?.since);
      const sinceField = auditSinceField(AuditModel);
      const rows = await AuditModel.findAll({where: { [sinceField]: { [Op.gte]: since } }, order: [["id", "ASC"]],});
      const visible = [];
      for (const row of rows) {
        const change = row.toJSON();
        if (await canViewAuditChange(change, { req, modules, routeRegistry, authContext })) visible.push(change);
      }
      res.json(ok(visible));
    },
  });
}

export function installAuditSseRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }) {
  installAuditRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }, {
    path: config.audit?.ssePath,
    operationId: "audit.sse",
    serviceMethod: "sse",
    summary: "Cambios en vivo",
    handler: ({ config, modules, routeRegistry, authContext }) => (req, res) => {
      res.writeHead(200, {"Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive"});
      res.write(": connected\n\n");

      const sendChange = (change) => {
        Promise.resolve(canViewAuditChange(change, { req, modules, routeRegistry, authContext }))
          .then((allowed) => { if (allowed) res.write(`event: audit\ndata: ${JSON.stringify(change)}\n\n`); })
          .catch(() => {});
      };
      config.audit.events.on("change", sendChange);

      const heartbeat = setInterval(() => {res.write(": heartbeat\n\n")}, config.audit.heartbeatTimeout);
      heartbeat.unref?.();

      req.on("close", () => {
        clearInterval(heartbeat);
        config.audit.events.off("change", sendChange);
      });
    },
  });
}

function normalizeAuditHeartbeatTimeout(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : fallback;
}

export function isAuditTableName(name) {
  return String(name || "").toLowerCase() === "audit";
}

function installAuditRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }, { path, operationId, serviceMethod, summary, handler }) {
  if (!config.audit || !path) return;

  const AuditModel = findAuditModel(modules, models);
  if (!AuditModel) return;

  const fullPath = joinPaths(config.basePath, path);
  const auth = config.auth || { required: false, strategies: [] };
  const permission = auth.required ? operationId : null;
  routeRegistry.register({ module: "audit", operationId, method: "get", expressPath: fullPath, openApiPath: fullPath, serviceMethod, auth, permissions: permission ? [permission] : [], summary, description: "", tags: ["audit"], deprecated: false});

  const routeHandler = handler({ AuditModel, config, modules, routeRegistry, authContext });
  const handlers = [];
  if (authorize) handlers.push(authorize({ auth, permissions: permission ? [permission] : [] }));
  handlers.push((req, res, next) => { Promise.resolve(routeHandler(req, res, next)).catch(next);});
  mainRouter.get(fullPath, ...handlers);
}

async function canViewAuditChange(change, { req, modules, routeRegistry, authContext }) {
  if (!authContext) return true;

  const route = routeForAuditChange(change, { modules, routeRegistry });
  if (!route) return false;
  if (!route.auth?.required) return true;

  const permissions = route.permissions || [];
  for (const permission of permissions) {
    if (!permission) continue;
    if (!(await canRequest(permission, req))) return false;
  }

  return true;
}

function canRequest(permission, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(statusCode) {
        this.statusCode = statusCode;
        return this;
      },
      json() {
        resolve(false);
        return this;
      },
    };

    Promise.resolve(iamCan(permission)(req, res, (error) => resolve(!error))).catch(() => resolve(false));
  });
}

function routeForAuditChange(change, { modules, routeRegistry }) {
  const mod = moduleForAuditChange(change, modules);
  if (!mod) return null;

  return routeRegistry.getAll().find((route) => route.module === mod.config.name && route.serviceMethod === "list") || null;
}

function moduleForAuditChange(change, modules) {
  const tableName = String(change?.tableName || "").toLowerCase();
  if (!tableName) return null;

  for (const mod of modules.values()) {
    const names = [mod.config?.name, mod.config?.resource?.options?.tableName, mod.model?._resolvedTableName, mod.model?.tableName, mod.model?.modelName, mod.model?.name, ].filter(Boolean).map((name) => String(name).toLowerCase());
    if (names.includes(tableName)) return mod;
  }

  return null;
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

async function writeAudit(AuditModel, auditConfig, ModelClass, action, model, oldData, newData, options = {}) {
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
  if (options.emit !== false) auditConfig?.events?.emit("change", auditRow.toJSON());
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

function jsonSafe(value) {
  if (!value || typeof value !== "object") return {};
  return JSON.parse(JSON.stringify(value));
}
