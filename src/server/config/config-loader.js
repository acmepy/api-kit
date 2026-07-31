import path from "node:path";
import { importModuleNamespace, fileExists } from "../utils/import-module.js";
import { defineResource } from "../define-resource.js";
import { camelCase } from "../utils/naming.js";

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
  const { name, basePath, description, tags, endpoints, schema, auth, audit, filterWhitelist, defaultOrder, maxSize, details, ...definition } = input;
  const resource = defineResource(definition);
  const moduleName = name || definition.tableName || definition.modelName?.toLowerCase();
  if (!Array.isArray(details)) return { name: moduleName, basePath, description, tags, endpoints, schema, auth, audit, filterWhitelist, defaultOrder, maxSize, details, resource};

  const detailResources = normalizeDetailResources({ parentDefinition: definition, parentResource: resource, details });
  return {
    name: moduleName,
    basePath,
    description,
    tags,
    endpoints,
    schema,
    auth,
    audit,
    filterWhitelist,
    defaultOrder,
    maxSize,
    details: Object.fromEntries(detailResources.map((detail) => [detail.name, detail.config])),
    detailResources: detailResources.map((detail) => detail.resource),
    resource,
  };
}

function isResourceDefinition(input) {
  return input && typeof input === "object" && !input.resource && input.attributes && input.modelName;
}

function normalizeDetailResources({ parentDefinition, parentResource, details }) {
  return details.map((detailDefinition) => {
    const { name, detailName, as, association, foreignKey, removeMissing, ...definition } = detailDefinition;
    const resource = defineResource(definition);
    const detail = name || detailName || as || association || detailNameFromDefinition(parentDefinition, definition);
    const fk = foreignKey || foreignKeyFromDefinition(parentDefinition, definition);
    const parentAlias = camelCase(parentDefinition.modelName || parentDefinition.tableName || "parent");

    parentResource.model.hasMany(resource.model, { as: detail, foreignKey: fk });
    resource.model.belongsTo(parentResource.model, { as: parentAlias, foreignKey: fk });

    return {
      name: detail,
      resource,
      config: { association: detail, ...(removeMissing !== undefined && { removeMissing }) },
    };
  });
}

function detailNameFromDefinition(parentDefinition, detailDefinition) {
  const tableName = detailDefinition.tableName;
  if (tableName) {
    const parentTable = parentDefinition.tableName || "";
    const singularParentTable = parentTable.endsWith("s") ? parentTable.slice(0, -1) : parentTable;
    if (singularParentTable && tableName.startsWith(`${singularParentTable}_`)) return tableName.slice(singularParentTable.length + 1);
    return tableName;
  }

  const modelName = detailDefinition.modelName || "details";
  const parentModelName = parentDefinition.modelName || "";
  if (parentModelName && modelName.startsWith(parentModelName)) {
    const suffix = modelName.slice(parentModelName.length);
    if (suffix) return camelCase(suffix);
  }
  return camelCase(modelName);
}

function foreignKeyFromDefinition(parentDefinition, detailDefinition) {
  const parentKey = `${camelCase(parentDefinition.modelName || parentDefinition.tableName || "parent")}Id`;
  if (detailDefinition.attributes?.[parentKey]) return parentKey;

  const idFields = Object.keys(detailDefinition.attributes || {}).filter((field) => field.endsWith("Id"));
  return idFields[0] || parentKey;
}
