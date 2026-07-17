import path from "node:path";
import { BaseModule } from "../base/base-module.js";
import { loadService } from "./service-loader.js";
import { loadRouter } from "./router-loader.js";
import { loadSchemas } from "./schema-loader.js";
import { getModelForModule } from "./model-loader.js";

export async function loadModule({moduleConfig, seq, modelsMap, routeRegistry, paths }) {
  const model = moduleConfig.resource?.model || getModelForModule(moduleConfig, modelsMap);
  const explicitSchemas = moduleConfig.resource?.schemas || moduleConfig.schemas;
  const schemas = await loadSchemas({ moduleName: moduleConfig.name, schemasDir: paths?.schemas, explicitSchemas});
  const service = await loadService({ moduleName: moduleConfig.name, model, schemas, config: moduleConfig, servicesDir: paths?.services });
  const router = await loadRouter({ moduleName: moduleConfig.name, service, config: moduleConfig, routeRegistry, routersDir: paths?.routers });
  return new BaseModule({ config: moduleConfig, model, service, router, schemas });
}
