import path from "node:path";
import express from "express";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { Op } from "seq";
import { RBAC } from "iam";
import { SeqAdapter } from "iam/adapters";
import { Auth, signJwt, verifyJwt } from "iam/express";
import { validateConfig } from "./config/config-validator.js";
import { loadModuleBundle } from "./config/config-loader.js";
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
import { AuthRequiredError } from "./errors/auth-required-error.js";
import { ForbiddenError } from "./errors/forbidden-error.js";

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
    auth: conf.auth,
    cors: conf.cors ?? false,
    helmet: conf.helmet ?? false,
    compression: conf.compression ?? false,
    rateLimit: conf.rateLimit ?? false,
    text: conf.text ?? false,
    trustProxy: conf.trustProxy ?? false,
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

  const moduleBundle = await loadModuleBundle(config.modules, config.baseDir);
  config.auth = normalizeGlobalAuth(mergeAuthConfig(moduleBundle.auth, config.auth));
  const authBackend = normalizeAuthBackendConfig(config.auth);
  const authContext = authBackend ? createAuthContext(config, authBackend) : null;
  const authorize = createAuthorizer(authContext);

  const rawModuleConfigs = moduleBundle.modules;
  const moduleConfigs = normalizeModules(rawModuleConfigs, { basePath: config.basePath, auth: config.auth });
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
    const mod = await loadModule({moduleConfig, seq: config.seq, modelsMap, routeRegistry, paths: resolvedPaths, authorize});

    modules.set(moduleConfig.name, mod);
    services.set(moduleConfig.name, mod.service);
    schemas.set(moduleConfig.name, mod.schemas);
    if (mod.model) models.set(moduleConfig.name, mod.model);
  }

  const mainRouter = express.Router();
  const packageInfo = await loadPackageInfo(config.baseDir);
  const openapi = normalizeOpenApiConfig(config.openapi);

  await installHttpMiddleware(mainRouter, config);
  mainRouter.use(runWithContext);

  installAuthRoutes({ mainRouter, routeRegistry, config, authContext, authorize });
  for (const mod of modules.values()) mainRouter.use(mod.mount());
  installAuditChangesRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext });
  installAuditSseRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext });
  if (openapi) {
    mainRouter.get(joinPaths(config.basePath, openapi.path || "/openapi.json"), (_req, res) => {
      res.json(buildOpenApiDocument({ routes: routeRegistry, modules, packageInfo, config: openapi }));
    });
  }

  mainRouter.use(errorHandler);

  return {router: mainRouter, errorHandler, modules, models, services, routes: routeRegistry, schemas, events: auditEvents, auth: authContext, close: async () => { auditEvents.removeAllListeners(); },
  };
}

async function installHttpMiddleware(router, config) {
  if (config.trustProxy !== false && config.trustProxy !== undefined) {
    router.use((req, _res, next) => {
      req.app.set("trust proxy", config.trustProxy);
      next();
    });
  }

  const corsOptions = normalizeMiddlewareOptions(config.cors);
  if (corsOptions) {
    const { default: cors } = await import("cors");
    router.use(cors(corsOptions === true ? undefined : corsOptions));
  }

  const helmetOptions = normalizeMiddlewareOptions(config.helmet);
  if (helmetOptions) {
    const { default: helmet } = await import("helmet");
    router.use(helmet(helmetOptions === true ? undefined : helmetOptions));
  }

  const compressionOptions = normalizeMiddlewareOptions(config.compression);
  if (compressionOptions) {
    const { default: compression } = await import("compression");
    router.use(compression(compressionOptions === true ? undefined : compressionOptions));
  }

  const rateLimitOptions = normalizeMiddlewareOptions(config.rateLimit);
  if (rateLimitOptions) {
    const { rateLimit } = await import("express-rate-limit");
    router.use(rateLimit(rateLimitOptions === true ? undefined : rateLimitOptions));
  }

  const textOptions = normalizeTextOptions(config.text);
  if (textOptions) router.use(express.text(textOptions));
}

function normalizeMiddlewareOptions(value) {
  if (!value) return false;
  if (value === true) return true;
  return value;
}

function normalizeTextOptions(value) {
  if (!value) return false;
  const defaults = { type: "text/plain", limit: "10mb" };
  if (value === true) return defaults;
  return { ...defaults, ...value };
}

function installAuditChangesRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }) {
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

function installAuditSseRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }) {
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

      const heartbeat = setInterval(() => {res.write(": heartbeat\n\n")}, 30000);
      heartbeat.unref?.();

      req.on("close", () => {
        clearInterval(heartbeat);
        config.audit.events.off("change", sendChange);
      });
    },
  });
}

function installAuditRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }, { path, operationId, serviceMethod, summary, handler }) {
  if (!config.audit || !path) return;

  const AuditModel = findAuditModel(modules, models);
  if (!AuditModel) return;

  const fullPath = joinPaths(config.basePath, path);
  const auth = config.auth || { required: false, strategies: [] };
  const permission = auth.required ? operationId : null;
  routeRegistry.register({
    module: "audit",
    operationId,
    method: "get",
    expressPath: fullPath,
    openApiPath: fullPath,
    serviceMethod,
    auth,
    permissions: permission ? [permission] : [],
    summary,
    description: "",
    tags: ["audit"],
    deprecated: false,
  });

  const routeHandler = handler({ AuditModel, config, modules, routeRegistry, authContext });
  const handlers = [];
  if (authorize) handlers.push(authorize({ auth, permissions: permission ? [permission] : [] }));
  handlers.push((req, res, next) => {
    Promise.resolve(routeHandler(req, res, next)).catch(next);
  });
  mainRouter.get(fullPath, ...handlers);
}

async function canViewAuditChange(change, { req, modules, routeRegistry, authContext }) {
  if (!authContext) return true;

  const route = routeForAuditChange(change, { modules, routeRegistry });
  if (!route) return false;
  if (!route.auth?.required) return true;

  const userId = req.session?.user?.id;
  if (!userId) return false;

  const permissions = route.permissions || [];
  for (const permission of permissions) {
    if (!permission) continue;
    if (!(await authContext.rbac.can(userId, permission))) return false;
  }

  return true;
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
    const names = [
      mod.config?.name,
      mod.config?.resource?.options?.tableName,
      mod.model?._resolvedTableName,
      mod.model?.tableName,
      mod.model?.modelName,
      mod.model?.name,
    ].filter(Boolean).map((name) => String(name).toLowerCase());

    if (names.includes(tableName)) return mod;
  }

  return null;
}

function installAuthRoutes({ mainRouter, routeRegistry, config, authContext, authorize }) {
  if (!authContext) return;

  const loginPath = joinPaths(config.basePath, authContext.loginPath);
  const logoutPath = joinPaths(config.basePath, authContext.logoutPath);

  routeRegistry.register({
    module: "auth",
    operationId: "auth.login",
    method: "post",
    expressPath: loginPath,
    openApiPath: loginPath,
    serviceMethod: "login",
    auth: { required: false, strategies: [] },
    permissions: [],
    summary: "Login",
    description: "",
    tags: ["auth"],
    deprecated: false,
  });

  routeRegistry.register({
    module: "auth",
    operationId: "auth.logout",
    method: "post",
    expressPath: logoutPath,
    openApiPath: logoutPath,
    serviceMethod: "logout",
    auth: { required: true, strategies: ["bearer", "basic"] },
    permissions: [],
    summary: "Logout",
    description: "",
    tags: ["auth"],
    deprecated: false,
  });

  mainRouter.post(loginPath, async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      const expiresAt = expiresAtFor(authContext.tokenExpiresIn);
      const session = await authContext.auth.login({ username, password, options: { expiresAt } });
      const token = await signJwt({ sessionId: session.id }, authContext.secret);
      await authContext.adapter.updateSession?.(session.id, { token, options: { ...session.options, expiresAt } });
      res.json(ok({ user: session.user, token, session: { id: session.id, expiresAt } }));
    } catch (error) {
      next(normalizeAuthError(error));
    }
  });

  mainRouter.post(logoutPath, authorize({ auth: { required: true, strategies: ["bearer", "basic"] }, permissions: [] }), async (req, res, next) => {
    try {
      if (req.session?.id) await authContext.auth.logout(req.session.id);
      res.json(ok(true));
    } catch (error) {
      next(normalizeAuthError(error));
    }
  });
}

function createAuthContext(config, authBackend) {
  const adapter = authBackend.adapter || new SeqAdapter({ seq: config.seq, models: authBackend.models });
  const rbac = new RBAC({ adapter });
  const auth = new Auth({ adapter, rbac });
  return {
    ...authBackend,
    adapter,
    auth,
    rbac,
    models: adapter.models || authBackend.models || null,
  };
}

function createAuthorizer(authContext) {
  return ({ auth = { required: false }, permissions = [] } = {}) => async (req, _res, next) => {
    try {
      if (!auth?.required) return next();
      if (!authContext) throw new AuthRequiredError("Auth no configurado");

      const session = await authenticateRequest(req, authContext, auth.strategies);
      req.session = session;
      req.user = session.user;
      setAuthContext(session);

      for (const permission of permissions || []) {
        if (!permission) continue;
        const allowed = await authContext.rbac.can(session.user.id, permission);
        if (!allowed) throw new ForbiddenError("No tiene permisos para realizar esta accion");
      }

      return next();
    } catch (error) {
      next(normalizeAuthError(error));
    }
  };
}

async function authenticateRequest(req, authContext, strategies = ["bearer", "basic"]) {
  const header = req.headers?.authorization || "";
  const allowed = normalizeStrategies(strategies);

  if (header.startsWith("Bearer ") && allowed.includes("bearer")) {
    const token = header.slice("Bearer ".length).trim();
    if (!token) throw new AuthRequiredError("Token requerido");
    const payload = await verifyJwt(token, authContext.secret);
    const session = await authContext.auth.getSession(payload.sessionId || payload.id);
    await assertSessionNotExpired(session, authContext);
    return session;
  }

  if (header.startsWith("Basic ") && allowed.includes("basic")) {
    return authenticateBasic(header, authContext);
  }

  throw new AuthRequiredError("Autenticacion requerida");
}

async function authenticateBasic(header, authContext) {
  const encoded = header.slice("Basic ".length).trim();
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) throw new AuthRequiredError("Credenciales invalidas");

  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  const user = await authContext.adapter.findUserByUsername(username);
  await authContext.auth.validateUser(user);
  await authContext.auth.validatePassword(user, password);
  return authContext.auth.createTemporarySession(user, {});
}

async function assertSessionNotExpired(session, authContext) {
  const expiresAt = session?.options?.expiresAt;
  if (!expiresAt) return;
  if (new Date(expiresAt).getTime() > Date.now()) return;
  if (session?.id) await authContext.auth.logout(session.id);
  throw new AuthRequiredError("Sesion expirada");
}

function setAuthContext(session) {
  const ctx = getContext();
  if (!ctx) return;
  ctx.user = session.user;
  ctx.session = session;
  ctx.audit = { ...(ctx.audit || {}), userId: session.user?.id || null };
}

function normalizeAuthBackendConfig(auth) {
  if (!auth?.required) return null;
  return {
    loginPath: "/login",
    logoutPath: "/logout",
    secret: process.env.IAM_SECRET || "api-kit-dev-secret",
    tokenExpiresIn: auth?.tokenExpiresIn || "1h",
    adapter: auth?.adapter,
    models: auth?.models,
    ...auth,
  };
}

function normalizeGlobalAuth(auth) {
  if (!auth) return { required: false, strategies: [] };
  if (auth === true) return { required: true, strategies: ["bearer", "basic"], tokenExpiresIn: "1h" };
  const strategies = auth.strategies || auth.strategy || ["bearer", "basic"];
  return { ...auth, required: auth.required ?? true, strategies: Array.isArray(strategies) ? strategies : [strategies] };
}

function mergeAuthConfig(base, override) {
  if (override === undefined) return base;
  if (override === false || override === null) return override;
  if (base && typeof base === "object" && override && typeof override === "object") return { ...base, ...override };
  return override;
}

function normalizeStrategies(strategies = []) {
  return strategies.map((strategy) => (strategy === "jwt" ? "bearer" : strategy));
}

function expiresAtFor(expiresIn) {
  return new Date(Date.now() + parseDuration(expiresIn)).toISOString();
}

function parseDuration(value) {
  if (typeof value === "number") return value * 1000;
  const match = String(value || "1h").trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!match) return 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  const multipliers = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return amount * multipliers[unit];
}

function normalizeAuthError(error) {
  if (error instanceof AuthRequiredError || error instanceof ForbiddenError || error instanceof ValidationError) return error;
  const code = error?.code;
  if (code === "FORBIDDEN" || error?.status === 403) return new ForbiddenError(error.message, { cause: error });
  if (error?.status === 401 || String(code || "").includes("AUTH") || String(code || "").includes("TOKEN") || String(code || "").includes("SESSION")) {
    return new AuthRequiredError(error.message, { cause: error });
  }
  return error;
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
