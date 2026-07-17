import path from "node:path";
import express from "express";
import { validateConfig } from "./config/config-validator.js";
import { loadModules } from "./config/config-loader.js";
import { normalizeModules } from "./config/config-normalizer.js";
import { RouteRegistry } from "./openapi/route-registry.js";
import { loadModels } from "./loaders/model-loader.js";
import { loadModule } from "./loaders/module-loader.js";
import { runWithContext } from "./context/request-context.js";
import { errorHandler } from "./http/error-handler.js";

export async function createApiKit(conf = {}) {
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
    openapi: conf.openapi || { enabled: false },
    sse: conf.sse || { enabled: false },
  };

  validateConfig(config);

  const resolvedPaths = {
    models: path.resolve(config.baseDir, config.paths.models),
    services: path.resolve(config.baseDir, config.paths.services),
    routers: path.resolve(config.baseDir, config.paths.routers),
    schemas: path.resolve(config.baseDir, config.paths.schemas),
  };

  const rawModuleConfigs = await loadModules(config.modules, config.baseDir);
  const moduleConfigs = normalizeModules(rawModuleConfigs, { basePath: config.basePath });

  const explicitModels = { ...config.models };
  for (const moduleConfig of moduleConfigs) {
    const resourceModel = moduleConfig.resource?.model;
    const modelName = resourceModel?.modelName || moduleConfig.resource?.options?.modelName || moduleConfig.resource?.model?.name;
    if (modelName && !explicitModels[modelName]) explicitModels[modelName] = resourceModel;
  }

  const modelsMap = await loadModels({seq: config.seq, explicitModels, modelsDir: resolvedPaths.models,moduleConfigs});

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

  mainRouter.use(runWithContext);

  for (const mod of modules.values()) mainRouter.use(mod.mount());

  mainRouter.use(errorHandler);

  return {router: mainRouter, errorHandler, modules, models, services, routes: routeRegistry, schemas, events: null, close: async () => {},
  };
}


