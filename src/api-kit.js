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

export async function createApiKit(userConfig = {}) {
  const config = {
    seq: userConfig.seq,
    baseDir: userConfig.baseDir || process.cwd(),
    models: userConfig.models || {},
    modules: userConfig.modules || [],
    paths: {
      models: userConfig.paths?.models || "./models",
      services: userConfig.paths?.services || "./services",
      routers: userConfig.paths?.routers || "./routers",
      schemas: userConfig.paths?.schemas || "./schemas",
    },
    iam: userConfig.iam || null,
    openapi: userConfig.openapi || { enabled: false },
    sse: userConfig.sse || { enabled: false },
  };

  validateConfig(config);

  const resolvedPaths = {
    models: path.resolve(config.baseDir, config.paths.models),
    services: path.resolve(config.baseDir, config.paths.services),
    routers: path.resolve(config.baseDir, config.paths.routers),
    schemas: path.resolve(config.baseDir, config.paths.schemas),
  };

  const rawModuleConfigs = await loadModules(config.modules, config.baseDir);
  const moduleConfigs = normalizeModules(rawModuleConfigs);

  const modelsMap = await loadModels({seq: config.seq, explicitModels: config.models, modelsDir: resolvedPaths.models,moduleConfigs});

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
