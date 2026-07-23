import path from "node:path";
import { importModuleNamespace, fileExists } from "../utils/import-module.js";
import { defineResource } from "../define-resource.js";

export async function loadModules(input, baseDir) {
  return (await loadModuleBundle(input, baseDir)).modules;
}

export async function loadModuleBundle(input, baseDir) {
  const bundle = { modules: [], auth: undefined, staticModules: [] };
  if (!input) return bundle;
  const items = Array.isArray(input) ? input : [input];
  for (const item of items) {
    if (typeof item === "object" && !Array.isArray(item)) {
      appendBundleItem(bundle, item);
      continue;
    }
    if (typeof item === "string") {
      const resolved = path.resolve(baseDir, item);
      if (await fileExists(resolved)) {
        const mod = await loadModuleFile(resolved);
        appendBundleItem(bundle, mod);
      }
    }
  }
  return bundle;
}

async function loadModuleFile(resolved) {
  const mod = await importModuleNamespace(resolved);
  const hasBundleExports = mod.modules !== undefined || mod.auth !== undefined || isModuleBundle(mod.default);
  if (!hasBundleExports) return mod.default || mod;

  const defaults = mod.default && typeof mod.default === "object" && !Array.isArray(mod.default) ? mod.default : {};
  return {
    ...defaults,
    modules: mod.modules ?? defaults.modules ?? (isModuleBundle(defaults) ? [] : mod.default),
    auth: mod.auth ?? defaults.auth,
  };
}

function appendBundleItem(bundle, item) {
  if (isModuleBundle(item)) {
    if (item.auth !== undefined) bundle.auth = item.auth;
    const modules = Array.isArray(item.modules) ? item.modules : [item.modules].filter(Boolean);
    appendModuleEntries(bundle, modules);
    return;
  }

  const modules = Array.isArray(item) ? item : [item];
  appendModuleEntries(bundle, modules);
}

function isModuleBundle(input) {
  return input && typeof input === "object" && !Array.isArray(input) && Array.isArray(input.modules);
}

function appendModuleEntries(bundle, entries) {
  for (const entry of entries) {
    if (isStaticModule(entry)) {
      bundle.staticModules.push(entry);
      continue;
    }

    bundle.modules.push(normalizeModuleInput(entry));
  }
}

function isStaticModule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (input.attributes || input.resource || input.modelName) return false;
  return Boolean(input.mountPath && (input.path || input.root || input.dir || input.directory || input.appName));
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
