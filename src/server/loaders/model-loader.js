import path from "node:path";
import { importModule, fileExists } from "../utils/import-module.js";
import { pascalCase } from "../utils/naming.js";
import { ConfigError } from "../errors/config-error.js";

export async function loadModels({ seq, explicitModels = {}, modelsDir, moduleConfigs }) {
  const loaded = new Map();
  for (const [name, modelClass] of Object.entries(explicitModels))  loaded.set(name, modelClass);
  if (modelsDir && await fileExists(modelsDir)) {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(modelsDir);

    for (const file of files) {
      if (!file.endsWith(".model.js")) continue;

      const modelName = file.replace(".model.js", "");
      const pascal = pascalCase(modelName);

      if (loaded.has(pascal) || loaded.has(modelName)) continue;

      const filePath = path.join(modelsDir, file);
      const exported = await importModule(filePath);

      const modelClass = normalizeModel(exported, pascal);
      if (modelClass) loaded.set(pascal, modelClass);
    }
  }

  return loaded;
}

function normalizeModel(exported, name) {
  if (typeof exported === "function") {
    if (exported.prototype && typeof exported.define === "function") return exported;
    if (exported.prototype && exported.prototype.constructor) return exported;
  }
  if (typeof exported === "function" && !exported.prototype?.define) return exported;
  return exported;
}

export function getModelForModule(moduleConfig, modelsMap) {
  const modelName = moduleConfig.model;
  if (!modelName) return null;
  if (modelsMap.has(modelName)) return modelsMap.get(modelName);
  const pascal = pascalCase(modelName);
  if (modelsMap.has(pascal)) return modelsMap.get(pascal);
  return null;
}
