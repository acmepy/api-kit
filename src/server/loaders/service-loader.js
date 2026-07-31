import path from "node:path";
import { importModule, fileExists } from "../utils/import-module.js";
import { camelCase } from "../utils/naming.js";
import { BaseService } from "../base/index.js";

export async function loadService({ moduleName, model, schemas, config, servicesDir, seq, models, services }) {
  if (servicesDir) {
    const filePath = path.join(servicesDir, `${camelCase(moduleName)}.js`);
    if (await fileExists(filePath)) {
      const ServiceClass = await importModule(filePath);
      if (typeof ServiceClass === "function") return new ServiceClass({ model, schemas, config, seq, models, services });
    }
  }

  return new BaseService({ model, schemas, config, seq, models, services });
}
