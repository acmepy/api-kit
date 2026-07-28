import path from "node:path";
import express from "express";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { Op } from "seq";
import { SeqAdapter } from "iam/adapters";
import { auth as iamAuth, can as iamCan } from "iam/express";
import { validateConfig } from "./config/config-validator.js";
import { loadModuleBundle } from "./config/config-loader.js";
import { normalizeModules } from "./config/config-normalizer.js";
import { RouteRegistry } from "./openapi/route-registry.js";
import { buildOpenApiDocument } from "./openapi/openapi-builder.js";
import { buildPostmanCollection } from "./postman/postman-builder.js";
import { loadModels, loadModule } from "./loaders/index.js";
import { installApp, normalizeInstallableApps, renderInstallHtml, renderInstallScript } from "./install/install.services.js";
import { runWithContext } from "./context/request-context.js";
import { getContext } from "./context/request-context.js";
import { errorHandler } from "./http/error-handler.js";
import { ok } from "./http/response.js";
import { ValidationError } from "./errors/validation-error.js";
import { requestLogger, setLogging } from "./logger/index.js";

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
    json: conf.json ?? true,
    text: conf.text ?? false,
    staticModules: [],
    trustProxy: conf.trustProxy ?? false,
    audit: normalizeAuditConfig(conf.audit),
    openapi: conf.openapi ?? null,
    postman: conf.postman ?? null,
    logging: conf.logging ?? false,
    sse: conf.sse || { enabled: false },
  };
  setLogging(config.logging || false);
  if (config.audit) config.audit.events = auditEvents;

  validateConfig(config);

  const resolvedPaths = {
    models: path.resolve(config.baseDir, config.paths.models),
    services: path.resolve(config.baseDir, config.paths.services),
    routers: path.resolve(config.baseDir, config.paths.routers),
    schemas: path.resolve(config.baseDir, config.paths.schemas),
  };

  const moduleBundle = await loadModuleBundle(config.modules, config.baseDir);
  config.staticModules.push(...moduleBundle.staticModules);
  config.installableApps = normalizeInstallableApps(config.staticModules, config.baseDir);
  config.auth = normalizeGlobalAuth(mergeAuthConfig(moduleBundle.auth, config.auth));
  const authBackend = normalizeAuthBackendConfig(config.auth);
  const authContext = authBackend ? createAuthContext(config, authBackend) : null;
  const authorize = createAuthorizer(authContext);

  const rawModuleConfigs = moduleBundle.modules;
  const moduleConfigs = normalizeModules(rawModuleConfigs, { basePath: config.basePath, auth: config.auth });
  installAuditHooks(moduleConfigs, config.audit);
  installAuthAuditHooks(authContext, moduleConfigs, config.audit);

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
  const postman = normalizePostmanConfig(config.postman, openapi);

  await installHttpMiddleware(mainRouter, config);
  mainRouter.use(runWithContext);
  mainRouter.use(requestLogger);

  installWelcomeRoute({ mainRouter, routeRegistry, config, packageInfo });
  installAuthRoutes({ mainRouter, routeRegistry, config, authContext });
  for (const mod of modules.values()) mainRouter.use(mod.mount());
  installAuditChangesRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext });
  installAuditSseRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext });
  installFrontendInstallRoutes({ mainRouter, routeRegistry, config, authorize });
  installOpenApiRoute({ mainRouter, routeRegistry, modules, packageInfo, config, openapi, authorize });
  installPostmanRoute({ mainRouter, routeRegistry, modules, packageInfo, config, postman, authorize });
  installStaticFiles(mainRouter, config);

  const app = conf.app || express();
  app.use(mainRouter);
  app.use(errorHandler);

  return {app, router: mainRouter, errorHandler, modules, models, services, routes: routeRegistry, schemas, events: auditEvents, auth: authContext, close: async () => { auditEvents.removeAllListeners(); },
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

  const jsonOptions = normalizeMiddlewareOptions(config.json);
  if (jsonOptions) router.use(express.json(jsonOptions === true ? undefined : jsonOptions));

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

function installWelcomeRoute({ mainRouter, routeRegistry, config, packageInfo }) {
  const fullPath = normalizeMountPath(config.basePath) || "/";
  const packageName = packageInfo.name || "api-kit";

  routeRegistry.register({ module: "system", operationId: "system.welcome", method: "get", expressPath: fullPath, openApiPath: fullPath, serviceMethod: "welcome", auth: { required: false, strategies: [] }, permissions: [], summary: "Backend welcome", description: "", tags: ["system"], deprecated: false });

  mainRouter.get(fullPath, (_req, res) => {res.json(ok({ name: packageName, message: `Bienvenido al backend de ${packageName}` }))});
}

function installStaticFiles(router, config) {
  for (const staticConfig of config.staticModules) {
    const normalized = normalizeStaticFileConfig(staticConfig, config.baseDir);
    if (!normalized) continue;

    router.use(normalized.mountPath, express.static(normalized.root, normalized.options));
    if (!normalized.spa) continue;

    router.get(new RegExp(`^${escapeRegExp(normalized.mountPath)}(?:/.*)?$`), (req, res, next) => {
      if (/\.[^/]+$/.test(req.path)) return next();
      res.sendFile(path.join(normalized.root, normalized.index));
    });
  }
}

function installFrontendInstallRoutes({ mainRouter, routeRegistry, config, authorize }) {
  const apps = config.installableApps || [];
  if (apps.length === 0) return;

  const auth = config.auth || { required: false, strategies: [] };
  const handlers = [];
  if (authorize) handlers.push(authorize({ auth, permissions: [] }));

  routeRegistry.register({ module: "install", operationId: "install.list", method: "get", expressPath: "/install", openApiPath: "/install", serviceMethod: "installList", auth, permissions: [], summary: "Instalador de frontends", description: "", tags: ["install"], deprecated: false });
  routeRegistry.register({ module: "install", operationId: "install.script", method: "get", expressPath: "/install/app.js", openApiPath: "/install/app.js", serviceMethod: "installScript", auth, permissions: [], summary: "Script del instalador", description: "", tags: ["install"], deprecated: false });
  routeRegistry.register({ module: "install", operationId: "install.run", method: "post", expressPath: "/install/:app", openApiPath: "/install/{app}", serviceMethod: "install", auth, permissions: [], summary: "Instalar frontend", description: "", tags: ["install"], deprecated: false });

  mainRouter.get("/install", ...handlers, (_req, res) => {res.type("html").send(renderInstallHtml(apps));});
  mainRouter.get("/install/", ...handlers, (_req, res) => {res.type("html").send(renderInstallHtml(apps))});
  mainRouter.get("/install/app.js", ...handlers, (_req, res) => {res.type("application/javascript").send(renderInstallScript());});

  mainRouter.post("/install/:app", ...handlers, async (req, res) => {
    const app = apps.find((item) => item.app === req.params.app);
    if (!app) return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "Frontend no encontrado" });
    const data = await installApp(app, { token: req.body?.token });
    res.json(ok(data));
  });
}

function normalizeStaticFileConfig(config, baseDir) {
  if (!config) return null;
  const value = typeof config === "string" ? { appName: config } : config;
  const mountPath = normalizeMountPath(value.mountPath || value.pathPrefix || (value.appName ? `/${value.appName}` : null));
  const rootInput = value.root || value.dir || value.directory || value.path || (value.appName ? `./public/${value.appName}` : null);
  if (!mountPath || !rootInput) return null;
  return {mountPath, root: path.resolve(baseDir, rootInput), spa: value.spa ?? true, index: value.index || "index.html", options: { redirect: false, ...value.options }};
}

function normalizeMountPath(value) {
  if (!value) return null;
  const clean = String(value).trim();
  if (!clean) return null;
  return clean.startsWith("/") ? clean.replace(/\/+$/g, "") || "/" : `/${clean.replace(/\/+$/g, "")}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function installOpenApiRoute({ mainRouter, routeRegistry, modules, packageInfo, config, openapi, authorize }) {
  if (!openapi) return;
  const fullPath = joinPaths(config.basePath, openapi.path || "/openapi.json");
  const auth = normalizeRouteAuth(openapi.auth);
  const permissions = openapi.permission ? [openapi.permission] : [];
  routeRegistry.register({ module: "openapi", operationId: "openapi.get", method: "get", expressPath: fullPath, openApiPath: fullPath, serviceMethod: "openapi", auth, permissions, summary: "OpenAPI document", description: "", tags: ["openapi"], deprecated: false});
  const handlers = [];
  if (authorize) handlers.push(authorize({ auth, permissions }));
  handlers.push((_req, res) => {res.json(buildOpenApiDocument({ routes: routeRegistry, modules, packageInfo, config: openapi}))});
  mainRouter.get(fullPath, ...handlers);
}

function installPostmanRoute({ mainRouter, routeRegistry, modules, packageInfo, config, postman, authorize }) {
  if (!postman) return;
  const fullPath = joinPaths(config.basePath, postman.path || "/postman.json");
  const auth = normalizeRouteAuth(postman.auth);
  const permissions = postman.permission ? [postman.permission] : [];
  routeRegistry.register({ module: "openapi", operationId: "postman.get", method: "get", expressPath: fullPath, openApiPath: fullPath, serviceMethod: "postman", auth, permissions, summary: "Postman collection", description: "", tags: ["postman"], deprecated: false});
  const handlers = [];
  if (authorize) handlers.push(authorize({ auth, permissions }));
  handlers.push((_req, res) => {res.json(buildPostmanCollection({ routes: routeRegistry, modules, packageInfo, config: { ...postman, basePath: config.basePath } }))});
  mainRouter.get(fullPath, ...handlers);
}

function normalizeRouteAuth(auth) {
  if (!auth) return { required: false, strategies: [] };
  if (auth === true) return { required: true, strategies: ["bearer", "basic"] };
  const strategies = auth.strategies || auth.strategy || ["bearer", "basic"];
  return { ...auth, required: auth.required ?? true, strategies: Array.isArray(strategies) ? strategies : [strategies] };
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

  const userId = req.session?.user?.id;
  if (!userId) return false;

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

function installAuthRoutes({ mainRouter, routeRegistry, config, authContext }) {
  if (!authContext) return;

  const loginPath = joinPaths(config.basePath, authContext.loginPath);
  const sessionPath = joinPaths(config.basePath, authContext.sessionPath);
  const logoutPath = joinPaths(config.basePath, authContext.logoutPath);

  routeRegistry.register({module: "auth", operationId: "auth.login", method: "post", expressPath: loginPath, openApiPath: loginPath, serviceMethod: "login", auth: { required: false, strategies: [] }, permissions: [], summary: "Login", description: "", tags: ["auth"], deprecated: false});
  routeRegistry.register({module: "auth", operationId: "auth.session", method: "get", expressPath: sessionPath, openApiPath: sessionPath, serviceMethod: "session", auth: { required: true, strategies: authContext.strategies }, permissions: [], summary: "Session", description: "", tags: ["auth"], deprecated: false});
  routeRegistry.register({module: "auth", operationId: "auth.logout", method: "post", expressPath: logoutPath, openApiPath: logoutPath, serviceMethod: "logout", auth: { required: true, strategies: ["bearer", "basic"] }, permissions: [], summary: "Logout", description: "", tags: ["auth"], deprecated: false});

  const basePath = normalizeMountPath(config.basePath) || "/";
  const authRouter = express.Router();
  authRouter.post(authContext.loginPath, authContext.middleware);
  authRouter.get(authContext.sessionPath, authContext.middleware);
  authRouter.post(authContext.logoutPath, authContext.middleware);
  mainRouter.use(basePath, authRouter);
}

function createAuthContext(config, authBackend) {
  const adapter = authBackend.adapter || new SeqAdapter({ seq: config.seq, models: authBackend.models });
  const middleware = iamAuth(iamAuthOptions(authBackend, adapter));
  return { ...authBackend, adapter, middleware, models: adapter.models || authBackend.models || null};
}

function createAuthorizer(authContext) {
  return ({ auth = { required: false }, permissions = [] } = {}) => {
    if (!auth?.required) return (_req, _res, next) => next();
    if (!authContext) return (_req, res) => res.status(401).json({ ok: false, message: "Auth no configurado" });

    const handlers = [
      iamAuth(iamAuthOptions({ ...authContext, ...auth }, authContext.adapter)),
      syncAuthContext,
      ...(permissions || []).filter(Boolean).map((permission) => iamCan(permission)),
      syncAuthContext,
    ];

    return composeMiddlewares(handlers);
  };
}

function setAuthContext(session) {
  const ctx = getContext();
  if (!ctx) return;
  ctx.user = session.user;
  ctx.session = session;
  ctx.audit = { ...(ctx.audit || {}), userId: session.user?.id || null };
}

function syncAuthContext(req, _res, next) {
  if (req.session) {
    req.user = req.session.user;
    setAuthContext(req.session);
  }
  next();
}

function composeMiddlewares(middlewares) {
  return (req, res, next) => {
    let index = 0;
    const run = (error) => {
      if (error) return next(error);
      const middleware = middlewares[index++];
      if (!middleware) return next();
      try {
        return Promise.resolve(middleware(req, res, run)).catch(next);
      } catch (err) {
        return next(err);
      }
    };
    return run();
  };
}

function iamAuthOptions(auth, adapter) {
  return {
    adapter,
    jwt: {
      secret: auth.secret,
      expiresIn: auth.tokenExpiresIn,
    },
    strategies: toIamStrategies(auth.strategies || ["bearer", "basic"]),
    createSession: auth.createSession,
  };
}

function normalizeAuthBackendConfig(auth) {
  if (!auth) return null;
  return {loginPath: "/login", sessionPath: "/session", logoutPath: "/logout", secret: process.env.IAM_SECRET || "api-kit-dev-secret", tokenExpiresIn: auth?.tokenExpiresIn || "1h", adapter: auth?.adapter, models: auth?.models, ...auth};
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

function toIamStrategies(strategies = []) {
  return normalizeStrategies(strategies).map((strategy) => (strategy === "bearer" ? "jwt" : strategy));
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

function installAuthAuditHooks(authContext, moduleConfigs, auditConfig) {
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

function normalizePostmanConfig(postman, openapi) {
  if (postman) return postman === true ? {} : postman;
  if (!openapi?.postman) return null;
  return {...openapi,path: openapi.postmanPath || "/postman.json"};
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
