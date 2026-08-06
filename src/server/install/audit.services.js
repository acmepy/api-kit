import { Op } from "seq";
import { getContext } from "../context/request-context.js";
import { ValidationError } from "../errors/validation-error.js";
import { ok } from "../http/response.js";
import { log } from "../logger/index.js";
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
    appendHook(hooks, "beforeUpsert", async function beforeAuditUpsert(values, options = {}) {
      const where = upsertWhereFor(this, moduleConfig, values, options);
      if (!where) return;
      const existing = await this.findOne({ where, ...(options.transaction && { transaction: options.transaction }) });
      if (existing) options.auditOld = snapshot(existing);
    });
    appendHook(hooks, "afterCreate", async function auditCreate(payload, options = {}) {
      await writeAudit(AuditModel, auditConfig, moduleConfig, "create", payload, {}, snapshot(payload), { transaction: options.transaction });
    });
    appendHook(hooks, "afterUpdate", async function auditUpdate(payload, options = {}) {
      if (Array.isArray(payload)) {
        for (const model of payload) await writeAudit(AuditModel, auditConfig, moduleConfig, "bulk-update", model, options.where || {}, snapshot(model), { transaction: options.transaction });
        return;
      }
      await writeAudit(AuditModel, auditConfig, moduleConfig, "update", payload, options.auditOld || previousData.get(payload) || {}, snapshot(payload), { transaction: options.transaction });
    });
    appendHook(hooks, "afterDestroy", async function auditDestroy(payload, options = {}) {
      if (isModelInstance(payload)) {
        await writeAudit(AuditModel, auditConfig, moduleConfig, "delete", payload, options.auditOld || previousData.get(payload) || snapshot(payload), {}, { transaction: options.transaction });
        return;
      }
      await writeAudit(AuditModel, auditConfig, moduleConfig, "bulk-delete", null, options.where || {}, {}, { transaction: options.transaction });
    });
    appendHook(hooks, "afterUpsert", async function auditUpsert(result, options = {}) {
      const [model, created] = Array.isArray(result) ? result : [result, false];
      await writeAudit(AuditModel, auditConfig, moduleConfig, created ? "create" : "update", model, created ? {} : options.auditOld || {}, snapshot(model), { transaction: options.transaction });
    });
    appendHook(hooks, "afterBulkCreate", async function auditBulkCreate(models, options = {}) {
      for (const model of models || []) await writeAudit(AuditModel, auditConfig, moduleConfig, "bulk-create", model, {}, snapshot(model), { transaction: options.transaction });
    });

    resource.options.hooks = hooks;
  }
}

export function installAuditChangesRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }) {
  installAuditRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }, {
    path: config.audit?.changesPath,
    operationId: "audit.changes",
    serviceMethod: "changes",
    summary: "Cambios desde una fecha",
    handler: ({ AuditModel, modules, authContext }) => async (req, res) => {
      const since = parseSince(req.query?.since);
      const sinceField = auditSinceField(modules);
      const rows = await AuditModel.findAll({where: { [sinceField]: { [Op.gte]: since } }, order: [["id", "ASC"]],});
      const visible = [];
      for (const row of rows) {
        const change = row.toJSON();
        if (await canViewAuditChange(change, { req, modules, authContext })) visible.push(change);
      }
      res.json(ok(visible));
    },
  });
}

export function createAuditWriter(moduleConfigs, auditConfig) {
  if (!auditConfig) return null;

  const auditModule = moduleConfigs.find((moduleConfig) => isAuditModule(moduleConfig));
  const AuditModel = auditModule?.resource?.model;
  if (!AuditModel) return null;

  return async function auditWrite(change) {
    const moduleConfig = {
      name: change.resource || change.module || change.tableName,
      resource: { definition: { id: { primaryKey: true } }, options: { tableName: change.tableName } },
    };
    await writeAudit(AuditModel, auditConfig, moduleConfig, change.action, plainAuditModel(change), change.old || {}, change.new || {}, { emit: change.emit ?? false });
  };
}

export function installAuditSseRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }) {
  const clients = new Map();
  let nextClientId = 0;

  const diagnostics = {
    sseClients: () => [...clients.values()].map(sseClientInfo),
  };

  installAuditRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }, {
    path: config.audit?.ssePath,
    operationId: "audit.sse",
    serviceMethod: "sse",
    summary: "Cambios en vivo",
    handler: ({ config, modules, authContext }) => (req, res) => {
      const [ip, session, userAgent] = [req.ip || req.socket?.remoteAddress || "", req.session?.id || "no-session", req.headers["user-agent"] || ""];
      res.writeHead(200, {"Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive"});
      res.write(": connected\n\n");
      log("info", "audit.sse", session, ip, req.method, req.originalUrl, res.statusCode, 0, res.getHeader("content-length") || 0, userAgent);
      const expiresAt = bearerTokenExpiresAt(req);
      const client = {id: ++nextClientId, req, res, sessionId: req.session?.id, connectedAt: new Date().toISOString(), expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, heartbeat: null, expirationTimer: null, closed: false};
      clients.set(client.id, client);

      const closeClient = (event = "session-closed") => {
        if (client.closed) return;
        client.closed = true;
        try {
          res.write(`event: ${event}\ndata: {}\n\n`);
        } catch (error) {
          log("error", "audit.sse", error);
        }
        res.end();
        cleanupSseClient(clients, client, config);
      };

      const validateClientSession = async (options = {}) => {
        if (!client.sessionId || !authContext?.adapter?.findSessionById) return true;
        const session = await findSessionById(authContext.adapter, client.sessionId, options);
        if (session && session.active !== false) return true;
        closeClient("session-closed");
        return false;
      };

      client.sendChange = (change, options = {}) => {
        Promise.resolve(validateClientSession(options))
          .then((active) => active && canViewAuditChange(change, { req, modules, authContext }))
          .then((allowed) => {
            if (!allowed || client.closed) return;
            try {
              res.write(`event: audit\ndata: ${JSON.stringify(change)}\n\n`);
            } catch (error) {
              log("error", "audit.sse", error);
            }
          })
          .catch((error) => log("error", "audit.sse", error));
      };
      config.audit.events.on("change", client.sendChange);

      if (expiresAt) {
        const timeout = Math.max(expiresAt - Date.now(), 0);
        client.expirationTimer = setTimeout(() => closeClient("auth-expired"), timeout);
        client.expirationTimer.unref?.();
      }

      client.heartbeat = setInterval(() => {
        Promise.resolve(validateClientSession())
          .then((active) => {if (active && !client.closed) res.write(": heartbeat\n\n")})
          .catch((error) => log("error", "audit.sse", error));
      }, config.audit.heartbeatTimeout);
      client.heartbeat.unref?.();

      req.on("close", () => {cleanupSseClient(clients, client, config)});
    },
  });

  return diagnostics;
}

function sseClientInfo(client) {
  return {
    id: client.id,
    sessionId: client.sessionId || null,
    closed: Boolean(client.closed),
    connectedAt: client.connectedAt,
    expiresAt: client.expiresAt,
    hasHeartbeat: Boolean(client.heartbeat),
    hasExpirationTimer: Boolean(client.expirationTimer),
  };
}

function cleanupSseClient(clients, client, config) {
  clients.delete(client.id);
  if (client.heartbeat) {
    clearInterval(client.heartbeat);
    client.heartbeat = null;
  }
  if (client.expirationTimer) {
    clearTimeout(client.expirationTimer);
    client.expirationTimer = null;
  }
  if (client.sendChange) config.audit.events.off("change", client.sendChange);
}

function bearerTokenExpiresAt(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  const exp = Number(payload?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

function bearerToken(req) {
  const header = req.headers?.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    return JSON.parse(Buffer.from(base64UrlToBase64(payload), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function base64UrlToBase64(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
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

function canViewAuditChange(change, { req, modules, authContext }) {
  const permissions = req.session?.permissions;
  if (!authContext || !Array.isArray(permissions)) return true;

  const mod = moduleForAuditChange(change, modules);
  if (!mod) return false;
  return permissions.includes(`${mod.config.name}.list`);
}

function moduleForAuditChange(change, modules) {
  const tableName = String(change?.tableName || "").toLowerCase();
  if (!tableName) return null;

  for (const mod of modules.values()) {
    const names = [mod.config?.name, mod.config?.resource?.options?.tableName, mod.model?.tableName, mod.model?.modelName, mod.model?.name, ].filter(Boolean).map((name) => String(name).toLowerCase());
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

function auditSinceField(modules) {
  const auditModule = [...modules.values()].find((mod) => isAuditModule(mod.config));
  return auditModule?.config?.resource?.options?.createdAt || "createdAt";
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

async function writeAudit(AuditModel, auditConfig, moduleConfig, action, model, oldData, newData, options = {}) {
  const tableName = tableNameFor(moduleConfig);
  if (!tableName || isAuditTableName(tableName)) return;

  const ctx = getContext() || {};
  const audit = ctx.audit || {};
  const auditRow = await AuditModel.create(
    {
      txId: ctx.txId || "",
      clientIp: audit.clientIp || audit.ip || "",
      userId: audit.userId || audit.usuarioId || null,
      tableName,
      rowId: rowId(model, moduleConfig) || rowIdFromWhere(oldData),
      action,
      old: jsonSafe(oldData || {}),
      new: jsonSafe(newData || {}),
    },
    { hooks: false, ...(options.transaction && { transaction: options.transaction }) },
  );
  if (options.emit !== false) auditConfig?.events?.emit("change", auditRow.toJSON(), { transaction: options.transaction });
}

async function findSessionById(adapter, sessionId, options = {}) {
  if (options.transaction && adapter?.models?.Session?.findByPk) {
    const session = await adapter.models.Session.findByPk(sessionId, { transaction: options.transaction });
    if (!session) return null;
    if (typeof session.get === "function") return session.get();
    if (typeof session.toJSON === "function") return session.toJSON();
    return session;
  }
  return adapter.findSessionById(sessionId);
}

function isModelInstance(value) {
  return value && typeof value === "object" && typeof value.toJSON === "function";
}

function snapshot(model) {
  if (!model || typeof model.toJSON !== "function") return {};
  return jsonSafe(model.toJSON());
}

function rowId(model, moduleConfig) {
  if (!model || (typeof model.get !== "function" && typeof model.getDataValue !== "function")) return "";
  const pk = primaryKeyFor(moduleConfig);
  const value = typeof model.get === "function" ? model.get(pk) : model.getDataValue(pk);
  if (value !== undefined && value !== null) return String(value);
  return "";
}

function primaryKeyFor(moduleConfig) {
  const definitions = moduleConfig?.resource?.definition || {};
  return Object.entries(definitions).find(([, definition]) => definition?.primaryKey)?.[0] || "id";
}

function upsertWhereFor(ModelClass, moduleConfig, values = {}, options = {}) {
  if (options.where && typeof options.where === "object" && !Array.isArray(options.where)) return options.where;

  const conflictFields = Array.isArray(options.conflictFields) ? options.conflictFields : [];
  if (conflictFields.length > 0 && conflictFields.every((field) => values[field] !== undefined && values[field] !== null)) {
    return Object.fromEntries(conflictFields.map((field) => [field, values[field]]));
  }

  const pk = ModelClass?.primaryKeyAttribute || primaryKeyFor(moduleConfig);
  if (pk && values[pk] !== undefined && values[pk] !== null) return { [pk]: values[pk] };

  const uniqueFields = uniqueFieldSets(moduleConfig, ModelClass);
  const fields = uniqueFields.find((fieldSet) => fieldSet.every((field) => values[field] !== undefined && values[field] !== null));
  return fields ? Object.fromEntries(fields.map((field) => [field, values[field]])) : null;
}

function uniqueFieldSets(moduleConfig, ModelClass) {
  const definitions = moduleConfig?.resource?.definition || ModelClass?.resourceDefinition?.attributes || ModelClass?.rawAttributes || {};
  const singleFieldSets = Object.entries(definitions)
    .filter(([, definition]) => definition?.unique === true)
    .map(([field]) => [field]);
  const schemaFieldSets = (ModelClass?._schema?.uniqueConstraints || [])
    .map((unique) => unique.columns || unique.fields || [])
    .filter((fields) => fields.length > 0);
  return [...singleFieldSets, ...schemaFieldSets];
}

function rowIdFromWhere(where = {}) {
  if (where.id !== undefined && where.id !== null) return String(where.id);
  return Object.values(where).filter((value) => value !== undefined && value !== null).join("_");
}

function tableNameFor(moduleConfig) {
  return moduleConfig?.resource?.options?.tableName || moduleConfig?.name || "";
}

function isAuditModule(moduleConfig) {
  return isAuditTableName(moduleConfig?.name) || isAuditTableName(moduleConfig?.resource?.options?.tableName) || isAuditTableName(moduleConfig?.resource?.options?.modelName);
}

function jsonSafe(value) {
  if (!value || typeof value !== "object") return {};
  return JSON.parse(JSON.stringify(value));
}

function plainAuditModel(change) {
  return {
    toJSON: () => ({ id: change.rowId, ...(change.new || {}) }),
    get: (key) => (key === "id" ? change.rowId : change.new?.[key]),
    getDataValue: (key) => (key === "id" ? change.rowId : change.new?.[key]),
  };
}
