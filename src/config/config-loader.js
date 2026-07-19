import path from "node:path";
import { importModule, fileExists } from "../utils/import-module.js";
import { defineResource } from "../define-resource.js";

export async function loadModules(input, baseDir) {
  if (!input) return [];
  const items = Array.isArray(input) ? input : [input];
  const results = [];
  for (const item of items) {
    if (typeof item === "object" && !Array.isArray(item)) {
      results.push(normalizeModuleInput(item));
      continue;
    }
    if (typeof item === "string") {
      const resolved = path.resolve(baseDir, item);
      if (await fileExists(resolved)) {
        const mod = await importModule(resolved);
        const arr = Array.isArray(mod) ? mod : mod.modules || [mod];
        results.push(...arr.map((entry) => normalizeModuleInput(entry)));
      }
    }
  }
  return results;
}

function normalizeModuleInput(input) {
  if (!isResourceDefinition(input)) return input;
  const { name, basePath, description, tags, endpoints, schema, auth, audit, filterWhitelist, defaultOrder, maxSize, ...definition } = input;
  const resource = defineResource(definition);
  const moduleName = name || definition.tableName || definition.modelName?.toLowerCase();
  return { name: moduleName, basePath, description, tags, endpoints, schema, auth, audit, filterWhitelist, defaultOrder, maxSize, resource};
}

function isResourceDefinition(input) {
  return input && typeof input === "object" && !input.resource && input.attributes && input.modelName;
}
