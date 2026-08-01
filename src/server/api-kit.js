import path from "node:path";
import express from "express";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { validateConfig } from "./config/config-validator.js";
import { loadModuleBundle } from "./config/config-loader.js";
import { normalizeModules } from "./config/config-normalizer.js";
import { normalizeOpenApiConfig } from "./schema/openapi-builder.js";
import { normalizePostmanConfig } from "./schema/postman-builder.js";
import { RouteRegistry } from "./schema/route-registry.js";
import { loadModels, loadModule } from "./loaders/index.js";
import { installFrontendInstallRoutes, normalizeInstallableApps } from "./install/install.services.js";
import { createAuditWriter, installAuditChangesRoute, installAuditHooks, installAuditSseRoute, normalizeAuditConfig } from "./install/audit.services.js";
import { createAuthContext, createAuthorizer, installAuthRoutes } from "./install/auth.services.js";
import { installHttpMiddleware } from "./install/http-middleware.services.js";
import { installOpenApiRoute, installPostmanRoute } from "./install/schema.services.js";
import { installStaticFiles } from "./install/static-files.services.js";
import { installPingRoute, installWelcomeRoute } from "./install/welcome.services.js";
import { runWithContext } from "./context/request-context.js";
import { errorHandler } from "./http/error-handler.js";
import { requestLogger, setLogging } from "./logger/index.js";
import { normalizeAuthBackendConfig, normalizeGlobalAuth } from "./utils/normalize.js";

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

  const rawModuleConfigs = moduleBundle.modules;
  const moduleConfigs = normalizeModules(rawModuleConfigs, { basePath: config.basePath, auth: config.auth });
  const authBackend = normalizeAuthBackendConfig(config.auth);
  const auditWriter = createAuditWriter(moduleConfigs, config.audit);
  const authContext = authBackend ? createAuthContext(config, authBackend, { auditWriter }) : null;
  const authorize = createAuthorizer(authContext);

  installAuditHooks(moduleConfigs, config.audit);

  const explicitModels = { ...config.models };
  for (const moduleConfig of moduleConfigs) {
    const resourceModel = moduleConfig.resource?.model;
    const modelName = resourceModel?.modelName || moduleConfig.resource?.options?.modelName || moduleConfig.resource?.model?.name;
    if (modelName && !explicitModels[modelName]) explicitModels[modelName] = resourceModel;
    for (const detailResource of moduleConfig.detailResources || []) {
      const detailModel = detailResource?.model;
      const detailModelName = detailModel?.modelName || detailResource?.options?.modelName || detailModel?.name;
      if (detailModelName && !explicitModels[detailModelName]) explicitModels[detailModelName] = detailModel;
    }
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
    const mod = await loadModule({moduleConfig, seq: config.seq, modelsMap, servicesMap: services, routeRegistry, paths: resolvedPaths, authorize});

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
  installPingRoute({ mainRouter, routeRegistry, config });
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

function mergeAuthConfig(base, override) {
  if (override === undefined) return base;
  if (override === false || override === null) return override;
  if (base && typeof base === "object" && override && typeof override === "object") return { ...base, ...override };
  return override;
}

function registerSeqModels(seq, modelClasses) {
  if (!seq || typeof seq.registerModel !== "function") return;

  for (const modelClass of new Set(modelClasses)) {
    if (!modelClass) continue;
    if (!modelClass.modelName && typeof modelClass.define === "function") modelClass.define(seq);
    const modelName = modelClass.modelName || modelClass.name;
    if (modelName && typeof seq.hasModel === "function" && seq.hasModel(modelName)) continue;
    if (modelClass.modelName) seq.registerModel(modelClass);
  }
}

async function loadPackageInfo(baseDir) {
  try {
    return JSON.parse(await readFile(path.resolve(baseDir, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

