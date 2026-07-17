import path from "node:path";
import { importModule, fileExists } from "../utils/import-module.js";
import { camelCase } from "../utils/naming.js";

export async function loadSchemas({ moduleName, schemasDir }) {
  const schemas = {};

  if (!schemasDir || !await fileExists(schemasDir)) {
    return schemas;
  }

  const filePath = path.join(schemasDir, `${camelCase(moduleName)}.schema.js`);
  if (await fileExists(filePath)) {
    const exported = await importModule(filePath);
    if (typeof exported === "object") {
      for (const [key, value] of Object.entries(exported)) {
        if (value && typeof value.validate === "function") schemas[key] = value;
      }
    }
  }

  return schemas;
}
