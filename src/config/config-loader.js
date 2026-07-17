import path from "node:path";
import { importModule, fileExists } from "../utils/import-module.js";

export async function loadModules(input, baseDir) {
  if (!input) return [];
  const items = Array.isArray(input) ? input : [input];
  const results = [];
  for (const item of items) {
    if (typeof item === "object" && !Array.isArray(item)) {
      results.push(item);
      continue;
    }
    if (typeof item === "string") {
      const resolved = path.resolve(baseDir, item);
      if (await fileExists(resolved)) {
        const mod = await importModule(resolved);
        const arr = Array.isArray(mod) ? mod : mod.modules || [mod];
        results.push(...arr);
      }
    }
  }
  return results;
}
