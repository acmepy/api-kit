import path from 'node:path';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import yep from 'yep';
import { Model, DataTypes, Op } from 'seq';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { RBAC } from 'iam';
import { SeqAdapter } from 'iam/adapters';
import { auth, can } from 'iam/express';

class AppError extends Error {
  constructor(message, { status = 500, code = "INTERNAL_ERROR", errors = null, cause = null } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.errors = errors;
    this.isOperational = true;
  }

  toJSON() {
    return { ok: false, code: this.code, message: this.message, ...(this.errors && { errors: this.errors })};
  }
}

class ConfigError extends AppError {
  constructor(message, { errors = null, cause = null } = {}) {
    super(message, { status: 500, code: "CONFIG_ERROR", errors, cause });
  }
}

function validateConfig(config) {
  const errors = {};
  if (!config.seq)  errors.seq = "seq instance is required";
  if (!config.baseDir) errors.baseDir = "baseDir is required";
  if (Object.keys(errors).length > 0) throw new ConfigError("Configuración inválida", { errors });
  return true;
}

async function importModule(filePath) {
  const absolute = path.resolve(filePath);
  const url = pathToFileURL(absolute).href;
  const mod = await import(url);
  return mod.default || mod;
}

async function importModuleNamespace(filePath) {
  const absolute = path.resolve(filePath);
  const url = pathToFileURL(absolute).href;
  return import(url);
}

async function fileExists(filePath) {
  const { access } = await import('node:fs/promises');
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const MODEL_OPTION_KEYS = new Set([ "modelName", "tableName", "timestamps", "createdAt", "updatedAt", "alias", "hooks"]);
const ATTRIBUTE_OPTION_KEYS = new Set(["type", "primaryKey", "autoIncrement", "allowNull", "defaultValue", "unique", "field", "references", "get", "set"]);
const DECLARATIVE_RULE_KEYS = new Set(["title", "required", "nullable", "default", "defaultValue", "oneOf", "notOneOf", "in", "pattern", "regexp", "matches", "email", "positive", "min", "max", "maxLength", "between"]);
const ATTRIBUTE_METADATA_KEYS = new Set([...ATTRIBUTE_OPTION_KEYS, ...DECLARATIVE_RULE_KEYS, "schema", "create", "update", "precision", "scale", "itemType", "items", "of", "returnType", "fields"]);
const STRING_TYPE_NORMALIZERS = {
  integer: () => DataTypes.INTEGER,
  int: () => DataTypes.INTEGER,
  string: (definition) => DataTypes.STRING(definition.maxLength),
  decimal: (definition) => DataTypes.DECIMAL(numberPrecision(definition), numberScale(definition)),
  number: (definition) => DataTypes.NUMBER(numberPrecision(definition), numberScale(definition)),
  boolean: () => DataTypes.BOOLEAN,
  bool: () => DataTypes.BOOLEAN,
  date: () => DataTypes.DATE,
  object: () => DataTypes.OBJECT,
  json: () => DataTypes.JSON,
  array: (definition) => DataTypes.ARRAY(normalizeNestedDataType(definition.itemType ?? definition.items ?? definition.of)),
  virtual: (definition) => DataTypes.VIRTUAL(normalizeNestedDataType(definition.returnType), definition.fields),
};

function defineResource(definition = {}) {
  const { attributes = {}, schemas = {}, model: CustomModel = null } = definition;
  const modelOptions = pickModelOptions(definition);
  const normalizedAttributes = normalizeAttributes(attributes);
  const modelAttributes = buildModelAttributes(normalizedAttributes);
  const ResourceModel = CustomModel || class extends Model {
    static define(seq) {return this.init(modelAttributes, { ...modelOptions, seq })}
  };
  const generatedSchemas = buildSchemas(normalizedAttributes, schemas, definition, ResourceModel);

  ResourceModel.attributes = modelAttributes;
  ResourceModel.resourceSchemas = generatedSchemas;
  ResourceModel.resourceDefinition = definition;

  return { model: ResourceModel, schemas: generatedSchemas, attributes: modelAttributes, definition: normalizedAttributes, options: modelOptions};
}

function pickModelOptions(definition) {
  const options = {};
  for (const key of MODEL_OPTION_KEYS)  if (definition[key] !== undefined) options[key] = definition[key];
  return options;
}

function normalizeAttributes(attributes) {
  const normalized = {};
  for (const [name, definition] of Object.entries(attributes)) normalized[name] = { ...definition, type: normalizeDataType(definition, name)};
  return normalized;
}

function normalizeDataType(definition, name) {
  if (isSeqDataTypeFactory(definition.type)) return definition.type._defaultType();
  if (isSeqDataType(definition.type)) return definition.type;
  if (typeof definition.type !== "string") throw new Error(`Attribute "${name}" type must be a string or seq DataType`);

  const type = normalizeTypeName(definition.type);
  const normalize = STRING_TYPE_NORMALIZERS[type];
  if (normalize) return normalize(definition);
  throw new Error(`Attribute "${name}" type "${definition.type}" is not supported`);
}

function normalizeNestedDataType(type) {
  if (type === undefined || type === null) return undefined;
  if (isSeqDataTypeFactory(type)) return type._defaultType();
  if (isSeqDataType(type)) return type;
  if (typeof type === "string") {
    const normalize = STRING_TYPE_NORMALIZERS[normalizeTypeName(type)];
    if (normalize) return normalize({ type });
  }
  return type;
}

function normalizeTypeName(type) {
  return type.trim().toLowerCase();
}

function isSeqDataTypeFactory(type) {
  return typeof type === "function" && typeof type._defaultType === "function";
}

function isSeqDataType(type) {
  return type && typeof type === "object" && typeof type.key === "string" && typeof type.validate === "function";
}

function numberPrecision(definition) {
  return definition.precision;
}

function numberScale(definition) {
  return definition.scale;
}

function buildModelAttributes(attributes) {
  const modelAttributes = {};
  for (const [name, definition] of Object.entries(attributes)) {
    const attribute = {};
    for (const key of ATTRIBUTE_OPTION_KEYS)  if (definition[key] !== undefined) attribute[key] = definition[key];
    modelAttributes[name] = attribute;
  }
  return modelAttributes;
}

function buildSchemas(attributes, explicitSchemas, definition = {}, model) {
  const generated = {
    create: explicitSchemas.create || yep.object(buildShape(attributes, "create", model)),
    update: explicitSchemas.update || yep.object(buildShape(attributes, "update", model)),
    ...explicitSchemas,
  };
  applyObjectRules(generated.create, definition, "create");
  applyObjectRules(generated.update, definition, "update");
  return generated;
}

function buildShape(attributes, operation, model) {
  const shape = {};
  for (const [name, definition] of Object.entries(attributes)) {
    if (!shouldIncludeInSchema(definition, operation)) continue;
    const schema = resolveValidation(definition, operation, model, primaryKeyName(attributes));
    if (schema) shape[name] = schema;
  }
  return shape;
}

function shouldIncludeInSchema(definition, operation) {
  if (isVirtualDataType(definition.type)) return false;
  if (definition.schema === false) return false;
  if (operation === "create" && definition.create === false) return false;
  if (operation === "update" && definition.update === false) return false;
  if (operation === "create" && definition.primaryKey && definition.autoIncrement) return false;
  if (operation === "update" && definition.primaryKey && definition.update !== true) return false;
  return true;
}

function isVirtualDataType(type) {
  return type?.key === "VIRTUAL" || type?.constructor?.name === "VirtualType";
}

function resolveValidation(definition, operation, model, primaryKey) {
  const schema = applyDeclarativeRules(inferValidation(definition), definition);
  if (!schema || typeof schema.validate !== "function") return null;
  if (operation === "create" && definition.allowNull === false && typeof schema.required === "function") schema.required();
  if (definition.allowNull === true && typeof schema.nullable === "function") schema.nullable();
  if (operation === "create" && definition.defaultValue !== undefined && typeof schema.default === "function") schema.default(definition.defaultValue);
  if (definition.unique === true && typeof schema.unique === "function") schema.unique(uniqueValidator(model, primaryKey));
  return schema;
}

function primaryKeyName(attributes) {
  return Object.entries(attributes).find(([, definition]) => definition.primaryKey)?.[0] || "id";
}

function uniqueValidator(model, primaryKey) {
  return async (value, field, data = {}) => {
    const existing = await model.findOne({ where: { [field]: value } });
    if (!existing) return null;
    const existingId = typeof existing.get === "function" ? existing.get(primaryKey) : existing[primaryKey];
    const currentId = data.__uniqueId ?? data[primaryKey];
    if (currentId !== undefined && String(existingId) === String(currentId)) return null;
    return new Error("Ya existe un registro con este valor");
  };
}

function applyDeclarativeRules(schema, definition) {
  if (!schema) return schema;
  applySchemaRule(schema, "title", definition.title);
  if (definition.required === true) applySchemaRule(schema, "required", true);
  if (definition.nullable === true) applySchemaRule(schema, "nullable", true);
  applySchemaRule(schema, "default", definition.default);
  applySchemaRule(schema, "oneOf", definition.oneOf);
  applySchemaRule(schema, "notOneOf", definition.notOneOf);
  applySchemaRule(schema, "in", definition.in);
  applySchemaRule(schema, "pattern", normalizePattern(definition.pattern));
  applySchemaRule(schema, "regexp", normalizePattern(definition.regexp));
  applySchemaRule(schema, "matches", normalizePattern(definition.matches));
  if (definition.email === true) applySchemaRule(schema, "email", true);
  if (definition.positive === true) applySchemaRule(schema, "positive", true);
  applySchemaRule(schema, "min", definition.min);
  applySchemaRule(schema, "max", definition.max);
  applySchemaRule(schema, "max", definition.maxLength);
  applySchemaRule(schema, "between", normalizeBetweenArgs(definition.between));
  applyCustomSchemaRules(schema, definition);
  return schema;
}

function applyObjectRules(schema, definition, operation) {
  if (!schema || typeof schema.requiredOneOf !== "function") return;
  const value = operation === "create" ? definition.requiredOneOfCreate ?? definition.requiredOneOf : definition.requiredOneOfUpdate ?? definition.requiredOneOf;
  applySchemaRule(schema, "requiredOneOf", value);
}

function applyCustomSchemaRules(schema, definition) {
  for (const [key, value] of Object.entries(definition)) {
    if (ATTRIBUTE_METADATA_KEYS.has(key)) continue;
    applySchemaRule(schema, key, value);
  }
}

function applySchemaRule(schema, method, value) {
  if (value === undefined || value === false || typeof schema[method] !== "function") return;
  if (value === true) {
    schema[method]();
    return;
  }
  if (Array.isArray(value)) {
    if (method === "between") schema[method](...value);
    else schema[method](value);
    return;
  }
  if (value && typeof value === "object" && Array.isArray(value.args)) {
    schema[method](...value.args);
    return;
  }
  schema[method](value);
}

function normalizeBetweenArgs(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value.min, value.max];
  return value;
}

function normalizePattern(value) {
  return typeof value === "string" ? new RegExp(value) : value;
}

function inferValidation(definition) {
  const typeName = definition.type?.key || definition.type?.constructor?.name || "";
  const normalized = typeName.toLowerCase();
  if (normalized.includes("string")) return yep.string();
  if (normalized.includes("integer")) return yep.integer();
  if (normalized.includes("decimal") || normalized.includes("number")) return yep.number();
  if (normalized.includes("boolean")) return yep.boolean();
  if (normalized.includes("date")) return yep.date();
  if (normalized.includes("array")) return yep.array();
  if (normalized.includes("object") || normalized.includes("json")) return yep.objectType();
  return null;
}

function camelCase(str) {
  return str.replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^(.)/, (_, c) => c.toLowerCase());
}

function snakeCase(str) {
  return String(str).replace(/([a-z])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
}

function pascalCase(str) {
  const cc = camelCase(str);
  return cc.charAt(0).toUpperCase() + cc.slice(1);
}

function applyNamingConvention(name, naming = {}) {
  let value = String(name);
  if (naming.tables === "snake_case") value = snakeCase(value);
  if (naming.tables === "camelCase") value = camelCase(value);
  if (naming.prefix && naming.tables) value = `${naming.prefix}_${value}`;
  if (naming.caseStyle === "upper") value = value.toUpperCase();
  if (naming.caseStyle === "lower") value = value.toLowerCase();
  return value;
}

async function loadModuleBundle(input, baseDir) {
  const bundle = { modules: [], staticModules: [] };
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
  const hasBundleExports = mod.modules !== undefined || isModuleBundle(mod.default);
  if (!hasBundleExports) return mod.default || mod;

  const defaults = mod.default && typeof mod.default === "object" && !Array.isArray(mod.default) ? mod.default : {};
  return {
    ...defaults,
    modules: mod.modules ?? defaults.modules ?? (isModuleBundle(defaults) ? [] : mod.default),
  };
}

function appendBundleItem(bundle, item) {
  if (isModuleBundle(item)) {
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

function joinPaths(...parts) {
  const clean = parts.filter((part) => part !== undefined && part !== null && part !== "").map((part) => String(part).trim()).filter(Boolean);
  if (clean.length === 0) return "/";
  const path = clean.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  return `/${path}`;
}

const ENDPOINT_DEFAULTS = {
  list: { enabled: true, method: "get", path: "/", summary: "Listar" },
  schema: { enabled: true, method: "get", path: "/schema", summary: "Schema" },
  get: { enabled: true, method: "get", path: "/:id", summary: "Obtener por ID" },
  create: { enabled: true, method: "post", path: "/", summary: "Crear" },
  update: { enabled: true, method: "put", path: "/:id", summary: "Actualizar" },
  remove: { enabled: true, method: "delete", path: "/:id", summary: "Eliminar" },
  createDetail: { enabled: false, method: "post", path: "/:id/:detail", summary: "Crear detalle" },
  updateDetail: { enabled: false, method: "put", path: "/:id/:detail/:detailId", summary: "Actualizar detalle" },
  removeDetail: { enabled: false, method: "delete", path: "/:id/:detail/:detailId", summary: "Eliminar detalle" },
};

const MODULE_DEFAULTS = { auth: { required: false, strategies: [] }, tags: [], description: "" };

function normalizeModule(config, options = {}) {
  const name = config.name;
  if (!name) throw new Error("Module config requires 'name'");

  const moduleBasePath = config.basePath || `/${name}`;
  const auth = normalizeAuth(config.auth === undefined ? options.auth : config.auth);
  const normalized = { ...MODULE_DEFAULTS, ...config, auth, name, basePath: joinPaths(options.basePath, moduleBasePath), endpoints: {}};

  for (const [op, defaults] of Object.entries(ENDPOINT_DEFAULTS)) {
    const userEndpoint = config.endpoints?.[op];
    const disabledByModuleOption = op === "schema" && config.schema === false;
    const enabledByDetails = isDetailEndpoint(op) && hasDetails(config);
    if (isDetailEndpoint(op) && userEndpoint === undefined && !enabledByDetails) continue;
    if (disabledByModuleOption || userEndpoint === false || userEndpoint?.enabled === false) {
      normalized.endpoints[op] = normalizeEndpoint({ ...defaults, ...userEndpoint, enabled: false }, normalized, op);
    } else if (userEndpoint !== undefined || enabledByDetails) {
      normalized.endpoints[op] = normalizeEndpoint({ ...defaults, ...(typeof userEndpoint === "object" ? userEndpoint : {}), enabled: true }, normalized, op);
    } else {
      normalized.endpoints[op] = normalizeEndpoint({ ...defaults }, normalized, op);
    }
  }

  if (config.endpoints) {
    for (const [key, value] of Object.entries(config.endpoints)) {
      if (!(key in normalized.endpoints)) normalized.endpoints[key] = normalizeEndpoint({ method: "get", path: `/${key}`, enabled: true, ...(typeof value === "object" ? value : {})}, normalized, key);
    }
  }
  return normalized;
}

function normalizeModules(configs, options = {}) {
  return configs.map((config) => normalizeModule(config, options));
}

function normalizeEndpoint(endpoint, moduleConfig, operation) {
  const auth = normalizeAuth(endpoint.auth === undefined ? moduleConfig.auth : endpoint.auth);
  const permission = endpoint.permission === undefined && auth.required ? `${moduleConfig.name}.${operation}` : endpoint.permission;
  return { ...endpoint, auth, permission };
}

function normalizeAuth(auth) {
  if (!auth) return { required: false, strategies: [] };
  if (auth === true) return { required: true, strategies: ["bearer", "basic"] };

  const strategies = auth.strategies || auth.strategy || ["bearer", "basic"];
  return {
    ...auth,
    required: auth.required ?? true,
    strategies: Array.isArray(strategies) ? strategies : [strategies],
  };
}

function isDetailEndpoint(operation) {
  return operation === "createDetail" || operation === "updateDetail" || operation === "removeDetail";
}

function hasDetails(config) {
  return config.details && typeof config.details === "object" && Object.keys(config.details).length > 0;
}

function normalizeMountPath(value) {
  if (!value) return null;
  const clean = String(value).trim();
  if (!clean) return null;
  return clean.startsWith("/") ? clean.replace(/\/+$/g, "") || "/" : `/${clean.replace(/\/+$/g, "")}`;
}

function normalizeMiddlewareOptions(value) {
  if (!value) return false;
  if (value === true) return true;
  return value;
}

function normalizeTextOptions(value) {
  if (!value) return false;
  const defaults = { type: "text/plain", limit: "10mb" };
  if (value === true) return defaults;
  return { ...defaults, ...value };
}

function normalizeStrategies(strategies = []) {
  return strategies.map((strategy) => (strategy === "jwt" ? "bearer" : strategy));
}

function toIamStrategies(strategies = []) {
  return normalizeStrategies(strategies).map((strategy) => (strategy === "bearer" ? "jwt" : strategy));
}

function normalizeGlobalAuth(auth) {
  if (!auth) return { required: false, strategies: [] };
  if (auth === true) return { required: true, strategies: ["bearer", "basic"], tokenExpiresIn: "1h" };
  const strategies = auth.strategies || auth.strategy || ["bearer", "basic"];
  return { ...auth, required: auth.required ?? true, strategies: Array.isArray(strategies) ? strategies : [strategies] };
}

function normalizeAuthBackendConfig(auth) {
  if (!auth) return null;
  return {loginPath: "/login", sessionPath: "/session", logoutPath: "/logout", secret: process.env.IAM_SECRET || "api-dev-secret", tokenExpiresIn: auth?.tokenExpiresIn || "1h", adapter: auth?.adapter, models: auth?.models, ...auth};
}

function normalizeJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  const normalized = Array.isArray(schema) ? schema.map((item) => normalizeJsonSchema(item)) : { ...schema };

  if (Array.isArray(normalized.type) && normalized.type.includes("null")) {
    const types = normalized.type.filter((type) => type !== "null");
    normalized.type = types.length === 1 ? types[0] : types;
    normalized.nullable = true;
  }

  if (normalized.properties) {
    normalized.properties = Object.fromEntries(
      Object.entries(normalized.properties).map(([key, value]) => [key, normalizeJsonSchema(value)]),
    );
  }

  if (normalized.items) normalized.items = normalizeJsonSchema(normalized.items);
  if (normalized.oneOf) normalized.oneOf = normalized.oneOf.map((item) => normalizeJsonSchema(item));
  if (normalized.anyOf) normalized.anyOf = normalized.anyOf.map((item) => normalizeJsonSchema(item));
  if (normalized.allOf) normalized.allOf = normalized.allOf.map((item) => normalizeJsonSchema(item));

  return normalized;
}

function normalizeOpenApiConfig(openapi) {
  if (!openapi) return null;
  if (openapi === true) return {};
  return openapi;
}

function buildOpenApiDocument({ routes, modules, packageInfo = {}, config = {} }) {
  const paths = {};
  const schemas = {};
  const securitySchemes = securitySchemesFor(routes.getAll());

  for (const mod of modules.values()) {
    const moduleSchemas = schemaComponents(mod);
    for (const [name, schema] of Object.entries(moduleSchemas)) schemas[componentName(mod.name, name)] = schema;
  }

  for (const route of routes.getAll()) {
    const path = route.openApiPath;
    if (!paths[path]) paths[path] = {};
    paths[path][route.method.toLowerCase()] = operationFor(route, modules);
  }

  return {
    openapi: "3.0.3",
    info: {
      title: config.title || packageInfo.name || "API",
      version: config.version || packageInfo.version || "1.0.0",
      ...(config.description || packageInfo.description ? { description: config.description || packageInfo.description } : {}),
    },
    servers: normalizeServers(config.servers || config.server),
    paths,
    components: Object.fromEntries(
      Object.entries({
        schemas,
        ...(Object.keys(securitySchemes).length > 0 ? { securitySchemes } : {}),
      }).filter(([, value]) => value && Object.keys(value).length > 0),
    ),
  };
}

function normalizeServers(servers) {
  if (!servers) return [{ url: "http://localhost:3000" }];
  if (typeof servers === "string") return [{ url: servers }];
  if (Array.isArray(servers)) return servers.map((server) => (typeof server === "string" ? { url: server } : server));
  return [servers];
}

function operationFor(route, modules) {
  const mod = modules.get(route.module);
  const operation = {
    operationId: openApiOperationId(route),
    summary: route.summary || undefined,
    description: route.description || undefined,
    tags: [openApiTag(route)],
    parameters: parametersFor(route),
    responses: responsesFor(route),
    security: securityFor(route),
    ...(route.permissions?.length ? { "x-permissions": route.permissions } : {}),
  };

  operation.requestBody = requestBodyFor(route, mod);

  return Object.fromEntries(Object.entries(operation).filter(([, value]) => value !== undefined));
}

function openApiOperationId(route) {
  return sanitizeOperationId(route.operationId || `${route.module}.${route.serviceMethod}`);
}

function sanitizeOperationId(operationId) {
  return String(operationId).replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function openApiTag(route) {
  return String(route.module);
}

function securitySchemesFor(routes) {
  const strategies = new Set(routes.flatMap((route) => route.auth?.required ? normalizeStrategies(route.auth.strategies) : []));
  const schemes = {};
  if (strategies.has("bearer")) schemes.bearerAuth = {type: "http", scheme: "bearer", bearerFormat: "JWT"};
  if (strategies.has("basic")) schemes.basicAuth = {type: "http", scheme: "basic"};
  return schemes;
}

function securityFor(route) {
  if (!route.auth?.required) return undefined;
  const strategies = normalizeStrategies(route.auth.strategies);
  const security = [];
  if (strategies.includes("bearer")) security.push({ bearerAuth: [] });
  if (strategies.includes("basic")) security.push({ basicAuth: [] });
  return security.length > 0 ? security : undefined;
}

function parametersFor(route) {
  const parameters = [];
  const matches = route.openApiPath.matchAll(/\{([^}]+)\}/g);

  for (const match of matches) parameters.push({name: match[1], in: "path", required: true, schema: { type: "string" }});

  if (route.serviceMethod === "list") {
    parameters.push(
      { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 20 } },
    );
  }

  if (route.serviceMethod === "changes") parameters.push({name: "since", in: "query", required: true, schema: { type: "string", format: "date-time" }});

  return parameters;
}

function responsesFor(route) {
  const authResponses = route.auth?.required ? {
    401: { description: "Authentication required" },
    403: { description: "Forbidden" },
  } : {};

  if (route.serviceMethod === "sse") {
    return {
      200: {description: "Event stream",content: {"text/event-stream": {schema: { type: "string" }}}}, 
      ...authResponses,
    };
  }

  if (route.serviceMethod === "list" || route.serviceMethod === "changes") {
    return {
      200: {description: "OK", content: {"application/json": {schema: {type: "object", properties: { ok: { type: "boolean" }, data: { type: "array", items: { type: "object" } }, pagination: { type: "object" }}}}}},
      ...authResponses,
    };
  }

  if (route.serviceMethod === "installList") {
    return {
      200: {description: "HTML installer", content: {"text/html": {schema: { type: "string" }}}},
      ...authResponses,
    };
  }

  if (route.serviceMethod === "installScript") {
    return {
      200: {description: "Installer script", content: {"application/javascript": {schema: { type: "string" }}}},
      ...authResponses,
    };
  }

  if (route.serviceMethod === "install") {
    return {
      200: {description: "OK", content: {"application/json": {schema: {type: "object", properties: { ok: { type: "boolean" }, data: { type: "object" }}}}}},
      ...authResponses,
      404: { description: "Not found" },
      500: { description: "Install failed" },
    };
  }

  return {
    200: {description: "OK", content: {"application/json": {schema: {type: "object", properties: { ok: { type: "boolean" }, data: { type: "object" }}}}}},
    400: { description: "Validation error" },
    ...authResponses,
    404: { description: "Not found" },
  };
}

function requestBodyFor(route, mod) {
  if (route.operationId === "auth.login") {
    return {
      required: true,
      content: {"application/json": {schema: {type: "object",required: ["username", "password"], properties: {username: { type: "string" }, password: { type: "string", format: "password" }}}}
      },
    };
  }

  if (route.operationId === "install.run") {
    return {
      required: false,
      content: {"application/json": {schema: {type: "object", properties: { token: { type: "string" } }}}},
    };
  }

  const bodySchemaName = requestBodySchemaName(route);
  if (!bodySchemaName || !mod?.schemas?.[bodySchemaName]) return undefined;
  return {required: bodySchemaName === "create", content: {"application/json": {schema: { $ref: `#/components/schemas/${componentName(route.module, bodySchemaName)}`}}}};
}

function requestBodySchemaName(route) {
  if (route.serviceMethod === "create") return "create";
  if (route.serviceMethod === "update") return "update";
  return null;
}

function schemaComponents(mod) {
  const result = {};
  for (const [name, schema] of Object.entries(mod.schemas || {})) {
    const jsonSchema = toJsonSchema(schema);
    if (jsonSchema) result[name] = enrichJsonSchema(jsonSchema, mod, name);
  }
  return result;
}

function enrichJsonSchema(schema, mod, operation) {
  if (!schema?.properties) return schema;
  const enriched = { ...schema, properties: { ...schema.properties } };
  const definitions = mod.config?.resource?.definition || mod.model?.resourceDefinition?.attributes || mod.model?.attributes || {};

  for (const [field, property] of Object.entries(enriched.properties)) {
    const definition = definitions[field];
    if (!definition) continue;
    if (operation === "create" && definition.create === false) continue;
    if (operation === "update" && definition.update === false) continue;
    enriched.properties[field] = enrichPropertySchema(property, definition);
  }

  return enriched;
}

function enrichPropertySchema(property, definition) {
  const enriched = { ...property };
  const type = definition.type;
  const typeName = type?.key || type?.constructor?.name || definition.type || "";
  const normalized = String(typeName).toLowerCase();
  const options = type?.options || {};

  if (normalized.includes("string")) {
    const maxLength = options.length ?? definition.maxLength;
    if (maxLength !== undefined) enriched.maxLength = maxLength;
  }

  if (normalized.includes("decimal") || normalized.includes("number")) {
    const precision = options.precision ?? definition.precision;
    const scale = options.scale ?? definition.scale;
    if (precision !== undefined) enriched.precision = precision;
    if (scale !== undefined) enriched.scale = scale;
  }

  return enriched;
}

function componentName(moduleName, schemaName) {
  return `${sanitizeComponentName(moduleName)}_${sanitizeComponentName(schemaName)}`;
}

function sanitizeComponentName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toJsonSchema(schema) {
  if (!schema || typeof schema.toJsonSchema !== "function") return null;
  return normalizeJsonSchema(schema.toJsonSchema());
}

const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

function normalizePostmanConfig(postman, openapi) {
  if (postman) return postman === true ? {} : postman;
  if (!openapi?.postman) return null;
  return {...openapi,path: openapi.postmanPath || "/postman.json"};
}

function buildPostmanCollection({ routes, modules = new Map(), packageInfo = {}, config = {} }) {
  const root = { name: basePathName(config.basePath), item: [] };
  const folders = new Map();

  for (const route of routes.getAll()) {
    if (route.serviceMethod === "postman") continue;
    if (isRootPostmanItem(route)) {
      root.item.push(postmanItemFor(route, modules));
      continue;
    }

    const folderName = postmanFolderName(route);
    if (!folders.has(folderName)) {
      const folder = { name: folderName, item: [] };
      folders.set(folderName, folder);
      root.item.push(folder);
    }
    folders.get(folderName).item.push(postmanItemFor(route, modules));
  }

  return {
    info: {
      name: config.title || packageInfo.name || "API",
      description: collectionDescription(config, packageInfo),
      schema: POSTMAN_SCHEMA,
    },
    item: [root],
    event: emptyEvents(),
    variable: postmanVariables(config),
  };
}

function isRootPostmanItem(route) {
  return route.module === "system";
}

function collectionDescription(config, packageInfo) {
  const description = config.description || packageInfo.description || "";
  const loginHelp = "Use el request Login para obtener el token.";
  return [description, loginHelp].filter(Boolean).join("\n\n");
}

function postmanFolderName(route) {
  if (route.module === "auth") return "session";
  if (route.module === "openapi") return route.openApiPath.split("/").filter(Boolean).pop() || route.module;
  return String(route.module);
}

function postmanItemFor(route, modules) {
  const request = {
    method: route.method.toUpperCase(),
    header: requestHeaders(route),
    url: postmanUrl(route),
  };

  if (route.auth?.required) request.auth = bearerAuth();
  const body = requestBody(route, modules);
  if (body) request.body = body;

  const item = {
    name: route.summary || route.operationId,
    request,
    response: responseExamples(route, request),
  };

  const events = itemEvents(route);
  if (events.length > 0) item.event = events;

  return item;
}

function requestHeaders(route) {
  const headers = [{ key: "Accept", value: acceptHeader(route) }];
  if (["post", "put", "patch"].includes(route.method.toLowerCase())) headers.unshift({ key: "Content-Type", value: "application/json" });
  return headers;
}

function acceptHeader(route) {
  if (route.serviceMethod === "sse") return "text/event-stream";
  if (route.serviceMethod === "installScript") return "application/javascript";
  if (route.serviceMethod === "installList") return "text/html";
  return "application/json";
}

function requestBody(route, modules) {
  const example = requestBodyExample(route, modules);
  if (!example) return null;
  return { mode: "raw", raw: JSON.stringify(example, null, 2), options: { raw: { headerFamily: "json", language: "json" } } };
}

function requestBodyExample(route, modules) {
  if (route.operationId === "auth.login") return { username: "admin", password: "1234" };
  if (route.operationId === "install.run") return { token: "" };
  if (!["create", "update"].includes(route.serviceMethod)) return null;

  const schema = modules.get(route.module)?.schemas?.[route.serviceMethod];
  const jsonSchema = schema?.toJsonSchema?.();
  return jsonSchema ? exampleFromJsonSchema(jsonSchema) : {};
}

function itemEvents(route) {
  if (route.operationId === "auth.logout") {
    return [
      {
        listen: "test",
        script: {
          exec: [
            "pm.collectionVariables.set(\"bearerToken\", null);",
            "",
          ],
          type: "text/javascript",
          packages: {},
          requests: {},
        },
      },
    ];
  }

  if (route.operationId !== "auth.login") return [];
  return [
    {
      listen: "test",
      script: {
        exec: [
          "const response = pm.response.json();",
          "pm.collectionVariables.set(\"bearerToken\", response.data.token);",
          "",
        ],
        type: "text/javascript",
        packages: {},
        requests: {},
      },
    },
  ];
}

function postmanUrl(route) {
  const path = route.openApiPath.replace(/\{([^}]+)\}/g, ":$1");
  const query = queryParams(route);
  const queryString = query.length ? `?${query.map((item) => `${item.key}=${encodeURIComponent(item.value)}`).join("&")}` : "";
  const variable = [...path.matchAll(/:([^/]+)/g)].map((match) => ({ key: match[1], value: "string" }));
  return {
    raw: `{{baseUrl}}${path}${queryString}`,
    host: ["{{baseUrl}}"],
    path: path.replace(/^\/+/, "").split("/").filter(Boolean),
    ...(query.length ? { query } : {}),
    ...(variable.length ? { variable } : {}),
  };
}

function queryParams(route) {
  if (route.serviceMethod === "list") return [{ key: "page", value: "1" }, { key: "limit", value: "20" }];
  if (route.serviceMethod === "changes") return [{ key: "since", value: new Date(0).toISOString() }];
  return [];
}

function bearerAuth() {
  return { type: "bearer", bearer: [{ key: "token", value: "{{bearerToken}}", type: "string" }] };
}

function responseExamples(route, request) {
  return responseStatuses(route).map(({ name, code, body }) => ({
    name,
    originalRequest: request,
    status: name,
    code,
    _postman_previewlanguage: body ? "json" : "text",
    header: body ? [{ key: "Content-Type", value: acceptHeader(route) }] : [],
    cookie: [],
    body: body || "",
  }));
}

function responseStatuses(route) {
  const statuses = [{ name: "OK", code: 200, body: responseBody(route) }];
  if (route.serviceMethod !== "list" && route.serviceMethod !== "changes" && route.serviceMethod !== "sse") statuses.push({ name: "Validation error", code: 400 });
  if (route.auth?.required) {
    statuses.push({ name: "Authentication required", code: 401 });
    statuses.push({ name: "Forbidden", code: 403 });
  }
  if (!["list", "changes", "sse"].includes(route.serviceMethod)) statuses.push({ name: "Not found", code: 404 });
  return statuses;
}

function responseBody(route) {
  if (route.serviceMethod === "sse") return "string";
  if (route.serviceMethod === "list" || route.serviceMethod === "changes") return JSON.stringify({ ok: true, data: [], pagination: {} }, null, 2);
  return JSON.stringify({ ok: true, data: {} }, null, 2);
}

function exampleFromJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return {};
  if (schema.default !== undefined) return schema.default;
  if (schema.example !== undefined) return schema.example;

  if (schema.type === "object" || schema.properties) {
    const result = {};
    for (const [name, property] of Object.entries(schema.properties || {})) result[name] = exampleFromJsonSchema(property);
    return result;
  }

  if (schema.type === "array") return [exampleFromJsonSchema(schema.items || { type: "string" })];
  if (schema.type === "integer") return 1;
  if (schema.type === "number") return 1;
  if (schema.type === "boolean") return true;
  if (schema.format === "email") return "user@example.com";
  if (schema.format === "date-time") return new Date(0).toISOString();
  if (schema.format === "date") return "1970-01-01";
  if (schema.type === "string") return "string";
  return null;
}

function postmanVariables(config) {
  return [
    { key: "baseUrl", value: firstServerUrl(config.servers || config.server) || "http://localhost:3000" },
    { key: "bearerToken", secret: true },
  ];
}

function firstServerUrl(servers) {
  if (!servers) return null;
  if (typeof servers === "string") return servers;
  if (Array.isArray(servers)) {
    const first = servers[0];
    return typeof first === "string" ? first : first?.url;
  }
  return servers.url;
}

function basePathName(basePath) {
  return String(basePath || "").split("/").filter(Boolean)[0] || "api";
}

function emptyEvents() {
  return [
    { listen: "prerequest", script: { type: "text/javascript", packages: {}, requests: {}, exec: [""] } },
    { listen: "test", script: { type: "text/javascript", packages: {}, requests: {}, exec: [""] } },
  ];
}

class RouteRegistry {
  #routes = new Map();

  register(descriptor) {
    const expressPath = descriptor.expressPath.replace(/\/+$/, "") || "/";
    const openApiPath = descriptor.openApiPath?.replace(/\/+$/, "") || "/";
    const key = `${descriptor.method}:${expressPath}`;
    if (this.#routes.has(key)) throw new Error(`Duplicate route: ${descriptor.method.toUpperCase()} ${expressPath}`);
    this.#routes.set(key, { ...descriptor, expressPath, openApiPath });
  }

  getAll() {
    return [...this.#routes.values()];
  }

  findBy(filter) {
    return this.#routes.values().filter((d) => {
      for (const [k, v] of Object.entries(filter))  if (d[k] !== v) return false;
      return true;
    });
  }

  has(method, expressPath) {
    return this.#routes.has(`${method}:${expressPath}`);
  }

  clear() {
    this.#routes.clear();
  }

  get size() {
    return this.#routes.size;
  }
}

async function loadModels({ seq, explicitModels = {}, modelsDir, moduleConfigs }) {
  const loaded = new Map();
  for (const [name, modelClass] of Object.entries(explicitModels))  loaded.set(name, modelClass);
  if (modelsDir && await fileExists(modelsDir)) {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(modelsDir);

    for (const file of files) {
      if (!file.endsWith(".model.js")) continue;

      const modelName = file.replace(".model.js", "");
      const pascal = pascalCase(modelName);

      if (loaded.has(pascal) || loaded.has(modelName)) continue;

      const filePath = path.join(modelsDir, file);
      const exported = await importModule(filePath);

      const modelClass = normalizeModel(exported);
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

function getModelForModule(moduleConfig, modelsMap) {
  const modelName = moduleConfig.model;
  if (!modelName) return null;
  if (modelsMap.has(modelName)) return modelsMap.get(modelName);
  const pascal = pascalCase(modelName);
  if (modelsMap.has(pascal)) return modelsMap.get(pascal);
  return null;
}

const storage = new AsyncLocalStorage();

function runWithContext(req, res, next) {
  const txId = req.headers["x-transaction-id"] || crypto.randomUUID();
  const context = {
    txId,
    audit: {
      clientIp: req.ip || req.socket?.remoteAddress || "",
      userId: req.user?.id || req.headers["x-user-id"] || req.headers["x-usuario-id"] || null,
    },
    baseUrl: `${req.protocol}://${req.get("host")}${req.originalUrl}`
  };
  storage.run(context, () => {next();});
}

function getContext() {
  return storage.getStore() || null;
}

class BaseModel extends Model {
  static define(_seq) {
    throw new Error(`${this.name} must implement static define(seq)`);
  }

  getContext() {
    return getContext();
  }

  toJSON() {
    const data = this.get();
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== "function" && typeof value !== "symbol") {
        result[key] = value;
      }
    }
    return result;
  }
}

class BaseModule {
  #config;
  #model;
  #service;
  #router;
  #schemas;

  constructor({ config, model, service, router, schemas = {} }) {
    this.#config = config;
    this.#model = model;
    this.#service = service;
    this.#router = router;
    this.#schemas = schemas;
  }

  get name() {
    return this.#config.name;
  }

  get basePath() {
    return this.#config.basePath;
  }

  get config() {
    return this.#config;
  }

  get model() {
    return this.#model;
  }

  get service() {
    return this.#service;
  }

  get router() {
    return this.#router;
  }

  get schemas() {
    return this.#schemas;
  }

  mount() {
    const router = express.Router();
    router.use(this.#config.basePath, this.#router.router);
    return router;
  }
}

function ok(data, meta = null) {
  const response = { ok: true, data };
  if (meta) response.meta = meta;
  return response;
}

function list(data, pagination) {
  return { ok: true, data, pagination };
}

class BaseRouter {
  #service;
  #config;
  #routeRegistry;
  #expressRouter;

  constructor({ service, config, routeRegistry, authorize }) {
    this.#service = service;
    this.#config = config;
    this.#routeRegistry = routeRegistry;
    this.authorize = authorize;
    this.#expressRouter = express.Router();
  }

  get service() {
    return this.#service;
  }

  get config() {
    return this.#config;
  }

  get router() {
    return this.#expressRouter;
  }

  build() {
    const endpoints = this.#config.endpoints || {};
    for (const [op, endpoint] of Object.entries(endpoints)) {
      if (!endpoint.enabled) {
        if (op === "schema") this.disabledRoute(endpoint.method || "get", endpoint.path || "/schema", "SCHEMA_DISABLED", "Schema disabled");
        continue;
      }
      const method = endpoint.method || "get";
      const path = endpoint.path || "/";
      const serviceMethod = op;
      this.route(method, path, {service: serviceMethod,permission: endpoint.permission, auth: endpoint.auth, summary: endpoint.summary, description: endpoint.description, tags: endpoint.tags || this.#config.tags});
    }

    this.registerCustomRoutes();
  }

  registerCustomRoutes() {}

  disabledRoute(method, path, code, message) {
    this.#expressRouter[method](path, async (_req, _res, next) => {
      next(new AppError(message, { status: 404, code }));
    });
  }

  route(method, path, options = {}) {
    const { service: serviceMethod, permission, auth, summary, description, tags } = options;

    const expressPath = path;
    const openApiPath = path.replace(/:([^/]+)/g, "{$1}");

    const descriptor = {
      module: this.#config.name,
      operationId: `${this.#config.name}.${serviceMethod}`,
      method,
      expressPath: `${this.#config.basePath}${expressPath}`,
      openApiPath: `${this.#config.basePath}${openApiPath}`,
      serviceMethod,
      auth: auth || this.#config.auth,
      permissions: permission ? [permission] : [],
      summary: summary || "",
      description: description || "",
      tags: tags || [],
      deprecated: false,
    };

    this.#routeRegistry.register(descriptor);

    const handlers = [];
    if (this.authorize) handlers.push(this.authorize({ auth: auth || this.#config.auth, permissions: permission ? [permission] : [] }));

    handlers.push(async (req, res, next) => {
      try {
        const {params, query, body} = req;
        const args = { params, query, body};

        const result = await this.#service[serviceMethod](args);
        if (result.pagination)  return res.json(list(result.data, result.pagination));
        return res.json(ok(result.data));
      } catch (err) {
        next(err);
      }
    });

    this.#expressRouter[method](expressPath, ...handlers);
  }
}

class NotFoundError extends AppError {
  constructor(resource = "Recurso", { cause = null } = {}) {
    super(`${resource} no encontrado`, { status: 404, code: "NOT_FOUND", cause });
  }
}

class ValidationError extends AppError {
  constructor(message = "Datos inválidos", { errors = null, cause = null } = {}) {
    super(message, { status: 400, code: "VALIDATION_ERROR", errors, cause });
  }
}

const FILTER_OPERATORS = { eq: Op.eq, equal: Op.eq, igual: Op.eq, gt: Op.gt, greater: Op.gt, mayor: Op.gt, gte: Op.gte, greaterOrEqual: Op.gte, mayorIgual: Op.gte, lt: Op.lt, less: Op.lt, menor: Op.lt, lte: Op.lte, lessOrEqual: Op.lte, menorIgual: Op.lte, like: Op.like, notLike: Op.notLike, in: Op.in, incluido: Op.in, between: Op.between };
const FILTER_OPERATOR_NAMES = new Map(Object.entries(FILTER_OPERATORS).map(([name, op]) => [op, name]));
const RANGE_OPERATORS = new Set([Op.gt, Op.gte, Op.lt, Op.lte, Op.between]);
const TYPES_COMPARABLES = ["integer", "decimal", "number", "date", "string"];
const isComparable = (type) => TYPES_COMPARABLES.includes(type);

class BaseService {
  #model;
  #schemas;
  #config;
  #seq;
  #models;
  #services;

  constructor({ model, schemas = {}, config = {}, seq = null, models = null, services = null }) {
    this.#model = model;
    this.#schemas = schemas;
    this.#config = config;
    this.#seq = seq;
    this.#models = models;
    this.#services = services;
  }

  get model() {
    return this.#model;
  }

  get schemas() {
    return this.#schemas;
  }

  get config() {
    return this.#config;
  }

  get seq() {
    return this.#seq;
  }

  get models() {
    return this.#models;
  }

  get services() {
    return this.#services;
  }

  async list({ params, query, body, transaction = null } = {}) {
    const context = getContext();
    const page = Math.max(1, parseInt(query?.page, 10) || 1);
    const maxSize = this.#config.maxSize || 100;
    const limit = Math.min(maxSize, Math.max(1, parseInt(query?.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const where = await this.#buildWhere(query);
    //const include = this.#detailDescriptors().map((descriptor) => ({ model: descriptor.target, as: descriptor.as }));
    const include = this.#model.getAssociationIncludes();
    const { count, rows } = await this.#model.findAndCountAll({ where, limit, offset, order: this.#config.defaultOrder || [], include: include.length ? include : undefined, distinct: Boolean(include.length), plain: true, ...(transaction && { transaction }) });
    const pages = Math.ceil(count / limit);
    return { data: rows, pagination: this.#buildPagination({ page, limit, offset, total: count, pages, baseUrl: context?.baseUrl }) };
  }

  async get({ params, query, body, transaction = null } = {}) {
    getContext();
    const instance = await this.#model.findByPk(params.id, { plain: true, ...(transaction && { transaction }) });
    //if (!instance) throw new NotFoundError(this.#resourceName());
    if (!instance) throw new NotFoundError(this.#model.modelName)
    return { data: instance };
  }

  async schema() {
    return {
      data: Object.fromEntries(
        Object.entries(this.#schemas).map(([name, schema]) => [name, this.#toJsonSchema(schema, name)]),
      ),
    };
  }

  async create({ params, query, body, transaction = null } = {}) {
    getContext();
    const { masterBody, include, hasDetails } = this.#masterDetailsContext(body);
    const data = await this.#schemas.create.validate(masterBody);
    const payload = hasDetails ? { ...body, ...data } : data;
    const instance = await this.#model.create(payload, { ...(hasDetails && { include }), ...(transaction && { transaction }) });
    return { data: instance.toJSON() };
  }

  async update({ params, query, body, transaction = null } = {}) {
    getContext();
    const { masterBody, include, hasDetails } = this.#masterDetailsContext(body);
    //const pk = this.#primaryKeyAttribute();
    const pk = this.#model.primaryKeyAttribute;
    const data = await this.#schemas.update.validate({ ...masterBody, __uniqueId: params.id });
    const payload = hasDetails ? { ...(body || {}), ...data, [pk]: params.id } : data;
    const [instance] = await this.#model.update(payload, { where: { [pk]: params.id }, ...(hasDetails && { include }), ...(transaction && { transaction }) });
    return { data: instance?.toJSON() || payload };
  }

  async remove({ params, query, body, transaction = null } = {}) {
    getContext();
    const instance = await this.#model.findByPk(params.id, { ...(transaction && { transaction }) });
    //if (!instance) throw new NotFoundError(this.#resourceName());
    if (!instance) throw new NotFoundError(this.#model.modelName)
    await instance.destroy({ ...(transaction && { transaction }) });
    return { data: instance.toJSON() };
  }

  async createDetail({ params, query, body, transaction = null } = {}) {
    getContext();
    //const {target, foreignKey} = this.#detailDescriptor(params.detail);
    const { model: target, foreignKey } = this.#model.getAssociationIncludes().find(a => a.as == params.detail);
    const parentId = Number.isNaN(Number(params.id)) ? params.id : Number(params.id);
    const data = await target.resourceSchemas.create.validate(body);
    const instance = await target.create({ ...data, [foreignKey]: parentId }, { ...(transaction && { transaction }) });
    return { data: instance.toJSON() }
  }

  async updateDetail({ params, query, body, transaction = null } = {}) {
    getContext();
    //const {name, target, primaryKey, foreignKey} = this.#detailDescriptor(params.detail);
    const { model: target, foreignKey } = this.#model.getAssociationIncludes().find(a => a.as == params.detail);
    const data = await target.resourceSchemas.update.validate(body);
    const [name, primaryKey] = [params.detail, target?.primaryKeyAttribute || "id"];
    const where = { [primaryKey]: params.detailId || body[primaryKey], [foreignKey]: params.id };
    const [instance] = await target.update(data, { where, ...(transaction && { transaction }) });
    if (!instance) throw new NotFoundError(name);
    return { data: instance?.toJSON() }
  }

  async removeDetail({ params, query, body, transaction = null } = {}) {
    getContext();
    //const {name, target, primaryKey, foreignKey} = this.#detailDescriptor(params.detail);
    const { model: target, foreignKey } = this.#model.getAssociationIncludes().find(a => a.as == params.detail);
    const [name, primaryKey] = [params.detail, target?.primaryKeyAttribute || "id"];
    const where = { [primaryKey]: params.detailId || body?.[primaryKey], [foreignKey]: params.id };
    const instance = await target.findOne({ where, ...(transaction && { transaction }) });
    if (!instance) throw new NotFoundError(name);
    const data = instance.toJSON();
    const removed = await target.destroy({ where, auditOld: data, ...(transaction && { transaction }) });
    if (!removed) throw new NotFoundError(name);
    return { data }
  }

  #masterDetailsContext(body = {}) {
    const detailsConfig = this.#detailsConfig();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(detailsConfig).length === 0) {
      return { masterBody: body, include: [], hasDetails: false };
    }

    const detailNames = Object.keys(detailsConfig).filter((key) => key in body);
    if (detailNames.length === 0) return { masterBody: body, include: [], hasDetails: false };

    const masterBody = { ...body };
    for (const key of detailNames) delete masterBody[key];
    //const descriptors = detailNames ? detailNames.map((name) => this.#detailDescriptor(name)) : this.#detailDescriptors();
    //const include = descriptors.map((descriptor) => ({ model: descriptor.target, as: descriptor.as }))
    const include = this.#model.getAssociationIncludes();

    return { masterBody, include, hasDetails: true };
  }

  /*#detailDescriptors() {
    return Object.keys(this.#detailsConfig()).map((name) => this.#detailDescriptor(name));
  }*/

  /*#detailDescriptor(name) {
    const detailsConfig = this.#detailsConfig();
    const config = detailsConfig[name];
    if (!config) throw new ValidationError(`Detalle "${name}" no estÃ¡ configurado`, { errors: { detail: "No configurado" } });

    const associationName = typeof config === "string" ? config : config.association || config.as || name;
    const association = this.#association(associationName);
    if (!association || association.type !== "hasMany") throw new ValidationError(`Detalle "${name}" debe usar una asociaciÃ³n hasMany`);

    return {
      name,
      association,
      as: association.as || associationName,
      target: association.target,
      foreignKey: association.foreignKey,
      primaryKey: association.target?.primaryKeyAttribute || "id",
      parentPrimaryKey: association.source?.primaryKeyAttribute || this.#primaryKeyAttribute(),
    };
  }
*/
  /*
    #association(name) {
      if (this.#model?.associations?.[name]) return this.#model.associations[name];
      return [...new Set(Object.values(this.#model?.associations || {}))].find((association) => association?.as === name) || null;
    }
  */
  #detailsConfig() {
    if (!this.#config.details || typeof this.#config.details !== "object" || Array.isArray(this.#config.details)) return {};
    return this.#config.details;
  }

  #toJsonSchema(schema, operation) {
    if (!schema) return {};
    if (typeof schema.toJsonSchema !== "function") return {};
    return schema.toJsonSchema()
    //return this.#enrichJsonSchema(normalizeJsonSchema(schema.toJsonSchema()), operation);
  }
  /*
    #enrichJsonSchema(schema, operation) {
      if (!schema?.properties) return schema;
  
      const enriched = { ...schema, properties: { ...schema.properties } };
      const definitions = this.#config.resource?.definition || this.#model?.resourceDefinition?.attributes || {};
  
      for (const [field, property] of Object.entries(enriched.properties)) {
        const definition = definitions[field];
        if (!definition) continue;
        if (operation === "create" && definition.create === false) continue;
        if (operation === "update" && definition.update === false) continue;
  
        enriched.properties[field] = this.#enrichPropertySchema(property, definition);
      }
  
      return enriched;
    }
  */
  /*
    #enrichPropertySchema(property, definition) {
      const enriched = { ...property };
      const type = definition.type;
      const typeName = type?.key || type?.constructor?.name || "";
      const normalized = typeName.toLowerCase();
      const options = type?.options || {};
      if (normalized.includes("string") && options.length !== undefined) enriched.maxLength = options.length;
      if ((normalized.includes("decimal") || normalized.includes("number")) && options.precision !== undefined) {
        enriched.precision = options.precision;
        if (options.scale !== undefined) enriched.scale = options.scale;
      }
      return enriched;
    }
  */
  /*
  #resourceName() {
    if (typeof this.#config.resourceName === "string") return this.#config.resourceName;
    if (typeof this.#config.title === "string") return this.#config.title;
    if (typeof this.#config.resource === "string") return this.#config.resource;
    return this.#model?.modelName || this.#config.name || "Recurso";
  }
  */

  #buildPagination({ page, limit, offset, total, pages, baseUrl }) {
    const pagination = { page, limit, offset, total, pages };
    if (!baseUrl) return pagination;

    pagination.links = {
      self: this.#paginationLink(baseUrl, page, limit),
      next: page < pages ? this.#paginationLink(baseUrl, page + 1, limit) : false,
      prev: page > 1 ? this.#paginationLink(baseUrl, page - 1, limit) : false,
    };

    return pagination;
  }

  #paginationLink(baseUrl, page, limit) {
    const url = new URL(baseUrl);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(limit));
    return url.toString();
  }

  async #buildWhere(query) {
    if (!query) return {};
    const where = {};
    const andFilters = [];
    const whitelist = this.#config.filterWhitelist || [];
    const definitions = this.#model.attributes;
    for (const [key, value] of Object.entries(query)) {
      if (["page", "limit"].includes(key)) continue;
      //const filters = this.#queryFilters(key, value);
      const [tmp, attribute, operator = 'eq'] = key.match(/^([a-zA-Z0-9_]+)\[([a-zA-Z0-9_]+)\]$/) || ['', key];
      if (!FILTER_OPERATORS[operator]) throw new ValidationError(`Operador de filtro "${operator}" no está soportado`);
      const filters = [{ field: attribute, operator: FILTER_OPERATORS[operator], value }];
      for (const filter of filters) {
        if (whitelist.length > 0 && !whitelist.includes(filter.field)) continue;
        const definition = definitions[filter.field];
        if (!definition && Object.keys(definitions).length > 0) throw new ValidationError(`Filtro "${filter.field}" no está permitido`);
        const parsedValue = await this.#parseFilterValue(filter.field, filter.operator, filter.value, definition);
        if (filter.operator === Op.eq) {
          where[filter.field] = parsedValue;
          continue;
        }
        andFilters.push({ [filter.field]: { [filter.operator]: parsedValue } });
      }
    }

    if (andFilters.length > 0) where[Op.and] = andFilters;
    return where;
  }

  /*#queryFilters(key, value) {
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      const symbolFilters = Object.getOwnPropertySymbols(value).map((operator) => ({ field: key, operator, value: value[operator] }));
      const namedFilters = Object.entries(value).map(([operatorName, operatorValue]) => {
        const operator = FILTER_OPERATORS[operatorName];
        if (!operator) throw new ValidationError(`Operador de filtro "${operatorName}" no está soportado`);
        return { field: key, operator, value: operatorValue };
      });
      return [...symbolFilters, ...namedFilters];
    }

    return [{ ...this.#parseFilterKey(key), value }];
  }*/

  #parseFilterKey(key) {
    const normalizedKey = String(key);
    const bracket = normalizedKey.match(/^(.+)\[([^\]]+)\]$/);
    const dotted = normalizedKey.match(/^(.+)\.([^.]+)$/);
    const underscored = normalizedKey.match(/^(.+)__([^_]+)$/);
    const match = bracket || dotted || underscored;
    const field = match ? match[1] : normalizedKey;
    const operatorName = match ? match[2] : "eq";
    const operator = FILTER_OPERATORS[operatorName];

    if (!operator) throw new ValidationError(`Operador de filtro "${operatorName}" no está soportado`);
    return { field, operator };
  }

  async #parseFilterValue(field, operator, value, definition) {
    if ([Op.in, Op.between].includes(operator)) {
      const values = this.#splitFilterValues(value);
      if (values.length === 0) throw new ValidationError(`Filtro "${field}" in requiere al menos un valor`);
      if (operator === Op.between && values.length !== 2) throw new ValidationError(`Filtro "${field}" between requiere dos valores`);
      let parsedValues = [];
      for (const item of values) parsedValues.push(await this.#castFilterValue(field, item, definition));
      this.#assertRangeOperator(field, operator, definition);
      return parsedValues;
    }
    this.#assertRangeOperator(field, operator, definition);
    return await this.#castFilterValue(field, value, definition);
  }

  #splitFilterValues(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return value.split(",").map((item) => item.trim());
    return [value];
  }

  #assertRangeOperator(field, operator, definition) {
    if (!isComparable(this.#filterType(definition)) && RANGE_OPERATORS.has(operator)) throw new ValidationError(`Filtro "${field}" no soporta operador "${FILTER_OPERATOR_NAMES.get(operator)}"`);
    /*if (!RANGE_OPERATORS.has(operator) || !definition) return;
    const type = this.#filterType(definition);
    const isComparable = ["integer", "decimal", "number", "date", "string"].includes(type);
    if (!isComparable) {
      const operatorName = FILTER_OPERATOR_NAMES.get(operator) || "filtro";
      throw new ValidationError(`Filtro "${field}" no soporta operador "${operatorName}"`);
    }*/
  }

  async #castFilterValue(field, value, definition) {
    const type = this.#filterType(definition);
    const schema = yep.fromJsonSchema({ type: 'object', properties: { [field]: { type } } });
    return await schema.validateAt(field, { [field]: value });
  }

  #filterType(definition) {
    return (definition?.type?.key || definition?.type).toLowerCase();
  }
}

async function loadService({ moduleName, model, schemas, config, servicesDir, seq, models, services }) {
  if (servicesDir) {
    const filePath = path.join(servicesDir, `${camelCase(moduleName)}.js`);
    if (await fileExists(filePath)) {
      const ServiceClass = await importModule(filePath);
      if (typeof ServiceClass === "function") return new ServiceClass({ model, schemas, config, seq, models, services });
    }
  }

  return new BaseService({ model, schemas, config, seq, models, services });
}

async function loadRouter({ moduleName, service, config, routeRegistry, routersDir, authorize }) {
  if (routersDir) {
    const filePath = path.join(routersDir, `${camelCase(moduleName)}.js`);
    if (await fileExists(filePath)) {
      const RouterClass = await importModule(filePath);
      if (typeof RouterClass === "function") {
        const router = new RouterClass({ service, config, routeRegistry, authorize });
        router.build();
        return router;
      }
    }
  }

  const router = new BaseRouter({ service, config, routeRegistry, authorize });
  router.build();
  return router;
}

async function loadSchemas({ moduleName, schemasDir, explicitSchemas = {} }) {
  const schemas = explicitSchemas;

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

async function loadModule({moduleConfig, seq, modelsMap, servicesMap, routeRegistry, paths, authorize }) {
  const model = moduleConfig.resource?.model || getModelForModule(moduleConfig, modelsMap);
  const explicitSchemas = moduleConfig.resource?.schemas || moduleConfig.schemas;
  const schemas = await loadSchemas({ moduleName: moduleConfig.name, schemasDir: paths?.schemas, explicitSchemas});
  const service = await loadService({ moduleName: moduleConfig.name, model, schemas, config: moduleConfig, servicesDir: paths?.services, seq, models: modelsMap, services: servicesMap });
  const router = await loadRouter({ moduleName: moduleConfig.name, service, config: moduleConfig, routeRegistry, routersDir: paths?.routers, authorize });
  return new BaseModule({ config: moduleConfig, model, service, router, schemas });
}

function normalizeInstallableApps(staticModules, baseDir) {
  return staticModules
    .filter((staticModule) => staticModule?.repo)
    .map((staticModule) => normalizeInstallableApp(staticModule, baseDir));
}

function installFrontendInstallRoutes({ mainRouter, routeRegistry, config, authorize }) {
  const apps = config.installableApps || [];
  if (apps.length === 0) return;

  const auth = config.auth || { required: false, strategies: [] };
  const handlers = [];
  if (authorize) handlers.push(authorize({ auth, permissions: [] }));

  routeRegistry.register({ module: "install", operationId: "install.list", method: "get", expressPath: "/install", openApiPath: "/install", serviceMethod: "installList", auth, permissions: [], summary: "Instalador de frontends", description: "", tags: ["install"], deprecated: false });
  routeRegistry.register({ module: "install", operationId: "install.script", method: "get", expressPath: "/install/app.js", openApiPath: "/install/app.js", serviceMethod: "installScript", auth, permissions: [], summary: "Script del instalador", description: "", tags: ["install"], deprecated: false });
  routeRegistry.register({ module: "install", operationId: "install.run", method: "post", expressPath: "/install/:app", openApiPath: "/install/{app}", serviceMethod: "install", auth, permissions: [], summary: "Instalar frontend", description: "", tags: ["install"], deprecated: false });

  mainRouter.get("/install", ...handlers, (_req, res) => {res.type("html").send(renderInstallHtml(apps));});
  mainRouter.get("/install/", ...handlers, (_req, res) => {res.type("html").send(renderInstallHtml(apps));});
  mainRouter.get("/install/app.js", ...handlers, (_req, res) => {res.type("application/javascript").send(renderInstallScript());});

  mainRouter.post("/install/:app", ...handlers, async (req, res) => {
    const app = apps.find((item) => item.app === req.params.app);
    if (!app) return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "Frontend no encontrado" });
    const data = await installApp(app, { token: req.body?.token });
    res.json(ok(data));
  });
}

async function installApp(app, { token, fetch: fetchImpl = globalThis.fetch } = {}) {
  try {
    const tokenValue = stringValue(token) || tokenForProvider(app.provider);
    const tag = app.version === "latest" ? await getLatestTag({ app, token: tokenValue, fetch: fetchImpl }) : app.version;
    const installedTag = readInstalledTag(app.target);

    if (installedTag === tag) return installResult(app, tag, "skipped");

    const archive = await downloadArchive({ app, tag, token: tokenValue, fetch: fetchImpl });
    await extractAndReplace({ app, archive, tag });
    return installResult(app, tag, "updated");
  } catch (error) {
    return { ...installResult(app, app.version, "failed"), error: error.message };
  }
}

function renderInstallHtml(apps) {
  const rows = apps.map((app) => {
    return `<tr data-app="${escapeHtml(app.app)}">
      <td>${escapeHtml(app.app)}</td>
      <td>${escapeHtml(app.mountPath)}</td>
      <td>${escapeHtml(app.repo)}</td>
      <td>${escapeHtml(app.version)}</td>
      <td data-field="status"></td>
      <td data-field="tag"></td>
      <td data-field="error"></td>
      <td><button type="button" data-install="${escapeHtml(app.app)}">Actualizar</button></td>
    </tr>`;
  }).join("\n");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>api install</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; color: #1f2937; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border-bottom: 1px solid #d1d5db; padding: .6rem; text-align: left; }
      button { cursor: pointer; padding: .4rem .7rem; }
      .failed { color: #b91c1c; }
      .updated { color: #047857; }
      .skipped { color: #4b5563; }
    </style>
  </head>
  <body>
    <h1>Instalar frontends</h1>
    <table>
      <thead>
        <tr><th>App</th><th>Path</th><th>Repo</th><th>Version</th><th>Status</th><th>Tag</th><th>Error</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <script src="/install/app.js"></script>
  </body>
</html>`;
}

function renderInstallScript() {
  return `document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-install]");
  if (!button) return;
  const app = button.dataset.install;
  const row = document.querySelector('[data-app="' + CSS.escape(app) + '"]');
  const set = (field, value) => row.querySelector('[data-field="' + field + '"]').textContent = value || "";
  button.disabled = true;
  row.className = "";
  set("status", "updating");
  set("tag", "");
  set("error", "");
  try {
    const url = new URL("/install/" + encodeURIComponent(app), window.location.protocol + "//" + window.location.host);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: "{}"
    });
    const payload = await response.json().catch(() => null);
    const data = payload && payload.data ? payload.data : {};
    if (!response.ok || !payload || payload.ok === false) throw new Error((payload && payload.message) || data.error || "Error");
    row.className = data.status || "";
    set("status", data.status);
    set("tag", data.tag);
    set("error", data.error);
  } catch (error) {
    row.className = "failed";
    set("status", "failed");
    set("error", error.message);
  } finally {
    button.disabled = false;
  }
});
`;
}

function normalizeInstallableApp(staticModule, baseDir) {
  const repo = parseRepo(staticModule.repo);

  const mountPath = normalizeMountPath(staticModule.mountPath || staticModule.pathPrefix || (staticModule.appName ? `/${staticModule.appName}` : null));
  if (!mountPath) throw new ValidationError("Static module instalable requiere mountPath", { errors: { mountPath: "Requerido" } });

  const publicRoot = path.resolve(baseDir, "public");
  const rootInput = staticModule.root || staticModule.dir || staticModule.directory || staticModule.path || (staticModule.appName ? `./public/${staticModule.appName}` : null);
  if (!rootInput) throw new ValidationError("Static module instalable requiere root", { errors: { root: "Requerido" } });

  const target = path.resolve(baseDir, rootInput);
  assertInsidePublic(target, publicRoot);

  return {
    app: appIdForMountPath(mountPath),
    mountPath,
    repo: repo.id,
    provider: repo.provider,
    repository: repo.repository,
    version: stringValue(staticModule.version) || "latest",
    dist: stringValue(staticModule.dist) || "www",
    target,
    targetLabel: relativePath(baseDir, target),
    publicRoot,
  };
}

async function getLatestTag({ app, token, fetch }) {
  assertGithubApp(app);
  const res = await githubFetch(`https://api.github.com/repos/${app.repository}/tags?per_page=1`, token, fetch);
  const tags = await res.json();
  if (!tags.length) throw new AppError("El repositorio no tiene tags.", { status: 404, code: "TAG_NOT_FOUND" });
  return tags[0].name;
}

async function downloadArchive({ app, tag, token, fetch }) {
  assertGithubApp(app);
  const res = await githubFetch(`https://api.github.com/repos/${app.repository}/zipball/${encodeURIComponent(tag)}`, token, fetch);
  return Buffer.from(await res.arrayBuffer());
}

async function githubFetch(url, token, fetch) {
  if (typeof fetch !== "function") throw new AppError("fetch no esta disponible", { status: 500, code: "FETCH_NOT_AVAILABLE" });
  const headers = { "User-Agent": "api", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new AppError(`GitHub respondio ${res.status}: ${await res.text()}`, { status: 502, code: "GITHUB_ERROR" });
  return res;
}

function readInstalledTag(target) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    return pkg.apiKitInstall?.tag || null;
  } catch {
    return null;
  }
}

async function extractAndReplace({ app, archive, tag }) {
  const extractDir = path.join(os.tmpdir(), `api-${app.app}-${tag}-${Date.now()}`);
  const staging = path.join(app.publicRoot, `.install-${app.app}-${Date.now()}`);

  try {
    removeDir(extractDir);
    removeDir(staging);
    fs.mkdirSync(extractDir, { recursive: true });
    new AdmZip(archive).extractAllTo(extractDir, true);

    const rootFolder = firstDirectory(extractDir);
    if (!rootFolder) throw new AppError("El archivo descargado no contiene archivos", { status: 422, code: "EMPTY_ARCHIVE" });

    const repoRoot = path.join(extractDir, rootFolder);
    const distSrc = path.resolve(repoRoot, app.dist);
    assertInside(distSrc, repoRoot, "dist debe estar dentro del proyecto descargado");
    if (!fs.existsSync(distSrc)) throw new ValidationError(`No existe la carpeta ${app.dist} en el proyecto descargado.`);

    copyDir(distSrc, staging);
    writePackageJson({ repoRoot, staging, app, tag });
    replaceTarget({ source: staging, target: app.target, publicRoot: app.publicRoot });
  } finally {
    removeDir(extractDir);
    removeDir(staging);
  }
}

function writePackageJson({ repoRoot, staging, app, tag }) {
  let pkg = {};
  const pkgSrc = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgSrc)) pkg = JSON.parse(fs.readFileSync(pkgSrc, "utf8"));
  pkg.apiKitInstall = { repo: app.repo, tag, dist: app.dist, installedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(staging, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function replaceTarget({ source, target, publicRoot }) {
  assertInsidePublic(target, publicRoot);
  const backup = `${target}.backup-${Date.now()}`;

  try {
    removeDir(backup);
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    removeDir(backup);
  } catch (error) {
    if (fs.existsSync(target)) removeDir(target);
    if (fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    const srcFile = path.join(src, file);
    const destFile = path.join(dest, file);
    const stat = fs.statSync(srcFile);
    if (stat.isDirectory()) {
      copyDir(srcFile, destFile);
    } else {
      fs.copyFileSync(srcFile, destFile);
    }
  }
}

function firstDirectory(dir) {
  return fs.readdirSync(dir).find((entry) => fs.statSync(path.join(dir, entry)).isDirectory());
}

function removeDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function installResult(app, tag, status) {
  return { mountPath: app.mountPath, app: app.app, repo: app.repo, tag, target: app.targetLabel, status };
}

function appIdForMountPath(mountPath) {
  return mountPath.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

function parseRepo(repo) {
  const value = stringValue(repo);
  const match = value.match(/^([a-z][a-z0-9+.-]*):([^:\s]+\/[^/\s]+)$/i);
  if (!match) {
    throw new ValidationError("Repo debe tener formato provider:owner/repo", { errors: { repo: "Formato invalido" } });
  }
  const provider = match[1].toLowerCase();
  const repository = match[2];
  if (provider !== "github") throw new ValidationError(`Proveedor de repo "${provider}" no soportado`, { errors: { repo: "Proveedor no soportado" } });
  return { id: `${provider}:${repository}`, provider, repository };
}

function assertGithubApp(app) {
  if (app.provider !== "github") throw new ValidationError(`Proveedor de repo "${app.provider}" no soportado`, { errors: { repo: "Proveedor no soportado" } });
}

function tokenForProvider(provider) {
  if (provider === "github") return process.env.GITHUB_TOKEN;
  return "";
}

function assertInsidePublic(target, publicRoot) {
  assertInside(target, publicRoot, "Target debe estar dentro de public");
}

function assertInside(target, root, message) {
  const relative = path.relative(root, target);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return;
  throw new ValidationError(message);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function relativePath(from, to) {
  return path.relative(from, to).replace(/\\/g, "/");
}

function stringValue(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

let _logging = false;

function setLogging(logging) {
  _logging = logging;
}

function log(level, path, ...args) {
  if (!_logging) return;
  if (_logging === true) return console[level]?.("[api] ["+path+"]", ...args);
  if (typeof _logging === "function") return _logging("[api] [ "+path+"]", level, ...args);
  if (typeof _logging === "object") return _logging[level]?.("[api] ["+path+"]", ...args);
}

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  const ip = req.ip || req.socket?.remoteAddress || "";
  const userAgent = req.headers["user-agent"] || "";

  res.on("finish", () => {
    const ctx = getContext();
    const txId = ctx?.txId || req.headers["x-transaction-id"] || "";
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    log("info", "request", txId, ip, req.method, req.originalUrl, res.statusCode, Number(durationMs.toFixed(2)), res.getHeader("content-length") || 0, userAgent);
  });

  next();
}

function errorLogger(err, req, { txId, status, code, errors }) {
  log(
    status >= 500 ? "error" : "warn", "http.error", 
    "["+txId+"]",  
    err.name || err.constructor?.name || "Error", 
    err.message, 
    status, 
    code, 
    req.method, 
    req.originalUrl || req.url, 
    errors, (status >= 500 && err.stack && { stack: err.stack })
  );
}

function normalizeAuditConfig(audit) {
  if (!audit) return false;
  const defaults = { changesPath: "/changes", ssePath: "/sse", heartbeatTimeout: 15000 };
  if (audit === true) return defaults;
  return { ...defaults, ...audit, heartbeatTimeout: normalizeAuditHeartbeatTimeout(audit.heartbeatTimeout, defaults.heartbeatTimeout) };
}

function installAuditHooks(moduleConfigs, auditConfig) {
  if (!auditConfig) return;

  const auditModule = moduleConfigs.find((moduleConfig) => isAuditModule(moduleConfig));
  const AuditModel = auditModule?.resource?.model;
  if (!AuditModel) return;

  for (const moduleConfig of moduleConfigs) {
    if (moduleConfig.audit === false || isAuditModule(moduleConfig)) continue;
    const resource = moduleConfig.resource;
    if (!resource?.model || !resource.options) continue;

    const hooks = { ...(resource.options.hooks || {}) };
    const previousData = new WeakMap();

    appendHook(hooks, "beforeUpdate", function beforeAuditUpdate(payload) {
      if (isModelInstance(payload)) previousData.set(payload, snapshot(payload));
    });
    appendHook(hooks, "beforeDestroy", function beforeAuditDestroy(payload) {
      if (isModelInstance(payload)) previousData.set(payload, snapshot(payload));
    });
    appendHook(hooks, "beforeUpsert", async function beforeAuditUpsert(values, options = {}) {
      const where = upsertWhereFor(this, moduleConfig, values, options);
      if (!where) return;
      const existing = await this.findOne({ where, ...(options.transaction && { transaction: options.transaction }) });
      if (existing) options.auditOld = snapshot(existing);
    });
    appendHook(hooks, "afterCreate", async function auditCreate(payload, options = {}) {
      await writeAudit(AuditModel, auditConfig, moduleConfig, "create", payload, {}, snapshot(payload), { transaction: options.transaction });
    });
    appendHook(hooks, "afterUpdate", async function auditUpdate(payload, options = {}) {
      if (Array.isArray(payload)) {
        for (const model of payload) await writeAudit(AuditModel, auditConfig, moduleConfig, "bulk-update", model, options.where || {}, snapshot(model), { transaction: options.transaction });
        return;
      }
      await writeAudit(AuditModel, auditConfig, moduleConfig, "update", payload, options.auditOld || previousData.get(payload) || {}, snapshot(payload), { transaction: options.transaction });
    });
    appendHook(hooks, "afterDestroy", async function auditDestroy(payload, options = {}) {
      if (isModelInstance(payload)) {
        await writeAudit(AuditModel, auditConfig, moduleConfig, "delete", payload, options.auditOld || previousData.get(payload) || snapshot(payload), {}, { transaction: options.transaction });
        return;
      }
      await writeAudit(AuditModel, auditConfig, moduleConfig, "bulk-delete", null, options.auditOld || options.where || {}, {}, { transaction: options.transaction });
    });
    appendHook(hooks, "afterUpsert", async function auditUpsert(result, options = {}) {
      const [model, created] = Array.isArray(result) ? result : [result, false];
      await writeAudit(AuditModel, auditConfig, moduleConfig, created ? "create" : "update", model, created ? {} : options.auditOld || {}, snapshot(model), { transaction: options.transaction });
    });
    appendHook(hooks, "afterBulkCreate", async function auditBulkCreate(models, options = {}) {
      for (const model of models || []) await writeAudit(AuditModel, auditConfig, moduleConfig, "bulk-create", model, {}, snapshot(model), { transaction: options.transaction });
    });

    resource.options.hooks = hooks;
  }
}

function installAuditChangesRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }) {
  installAuditRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }, {
    path: config.audit?.changesPath,
    operationId: "audit.changes",
    serviceMethod: "changes",
    summary: "Cambios desde una fecha",
    handler: ({ AuditModel, modules, authContext }) => async (req, res) => {
      const since = parseSince(req.query?.since);
      const sinceField = auditSinceField(modules);
      const rows = await AuditModel.findAll({where: { [sinceField]: { [Op.gte]: since } }, order: [["id", "ASC"]],});
      const visible = [];
      for (const row of rows) {
        const change = row.toJSON();
        if (await canViewAuditChange(change, { req, modules, authContext })) visible.push(change);
      }
      res.json(ok(visible));
    },
  });
}

function createAuditWriter(moduleConfigs, auditConfig) {
  if (!auditConfig) return null;

  const auditModule = moduleConfigs.find((moduleConfig) => isAuditModule(moduleConfig));
  const AuditModel = auditModule?.resource?.model;
  if (!AuditModel) return null;

  return async function auditWrite(change) {
    const moduleConfig = {
      name: change.resource || change.module || change.tableName,
      resource: { definition: { id: { primaryKey: true } }, options: { tableName: change.tableName } },
    };
    await writeAudit(AuditModel, auditConfig, moduleConfig, change.action, plainAuditModel(change), change.old || {}, change.new || {}, { emit: change.emit ?? false });
  };
}

function installAuditSseRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }) {
  const clients = new Map();
  let nextClientId = 0;

  const diagnostics = {
    sseClients: () => [...clients.values()].map(sseClientInfo),
  };

  installAuditRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }, {
    path: config.audit?.ssePath,
    operationId: "audit.sse",
    serviceMethod: "sse",
    summary: "Cambios en vivo",
    handler: ({ config, modules, authContext }) => (req, res) => {
      const [ip, session, userAgent] = [req.ip || req.socket?.remoteAddress || "", req.session?.id || "no-session", req.headers["user-agent"] || ""];
      res.writeHead(200, {"Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive"});
      res.write(": connected\n\n");
      log("info", "audit.sse", session, ip, req.method, req.originalUrl, res.statusCode, 0, res.getHeader("content-length") || 0, userAgent);
      const expiresAt = bearerTokenExpiresAt(req);
      const client = {id: ++nextClientId, req, res, sessionId: req.session?.id, connectedAt: new Date().toISOString(), expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, heartbeat: null, expirationTimer: null, closed: false};
      clients.set(client.id, client);

      const closeClient = (event = "session-closed") => {
        if (client.closed) return;
        client.closed = true;
        try {
          res.write(`event: ${event}\ndata: {}\n\n`);
        } catch (error) {
          log("error", "audit.sse", error);
        }
        res.end();
        cleanupSseClient(clients, client, config);
      };

      const validateClientSession = async (options = {}) => {
        if (!client.sessionId || !authContext?.adapter?.findSessionById) return true;
        const session = await findSessionById(authContext.adapter, client.sessionId, options);
        if (session && session.active !== false) return true;
        closeClient("session-closed");
        return false;
      };

      client.sendChange = (change, options = {}) => {
        Promise.resolve(validateClientSession(options))
          .then((active) => active && canViewAuditChange(change, { req, modules, authContext }))
          .then((allowed) => {
            if (!allowed || client.closed) return;
            try {
              res.write(`event: audit\ndata: ${JSON.stringify(change)}\n\n`);
            } catch (error) {
              log("error", "audit.sse", error);
            }
          })
          .catch((error) => log("error", "audit.sse", error));
      };
      config.audit.events.on("change", client.sendChange);

      if (expiresAt) {
        const timeout = Math.max(expiresAt - Date.now(), 0);
        client.expirationTimer = setTimeout(() => closeClient("auth-expired"), timeout);
        client.expirationTimer.unref?.();
      }

      client.heartbeat = setInterval(() => {
        Promise.resolve(validateClientSession())
          .then((active) => {if (active && !client.closed) res.write(": heartbeat\n\n");})
          .catch((error) => log("error", "audit.sse", error));
      }, config.audit.heartbeatTimeout);
      client.heartbeat.unref?.();

      req.on("close", () => {cleanupSseClient(clients, client, config);});
    },
  });

  return diagnostics;
}

function sseClientInfo(client) {
  return {
    id: client.id,
    sessionId: client.sessionId || null,
    closed: Boolean(client.closed),
    connectedAt: client.connectedAt,
    expiresAt: client.expiresAt,
    hasHeartbeat: Boolean(client.heartbeat),
    hasExpirationTimer: Boolean(client.expirationTimer),
  };
}

function cleanupSseClient(clients, client, config) {
  clients.delete(client.id);
  if (client.heartbeat) {
    clearInterval(client.heartbeat);
    client.heartbeat = null;
  }
  if (client.expirationTimer) {
    clearTimeout(client.expirationTimer);
    client.expirationTimer = null;
  }
  if (client.sendChange) config.audit.events.off("change", client.sendChange);
}

function bearerTokenExpiresAt(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  const exp = Number(payload?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

function bearerToken(req) {
  const header = req.headers?.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    return JSON.parse(Buffer.from(base64UrlToBase64(payload), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function base64UrlToBase64(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
}

function normalizeAuditHeartbeatTimeout(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : fallback;
}

function isAuditTableName(name) {
  return String(name || "").toLowerCase() === "audit";
}

function installAuditRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext }, { path, operationId, serviceMethod, summary, handler }) {
  if (!config.audit || !path) return;

  const AuditModel = findAuditModel(modules, models);
  if (!AuditModel) return;

  const fullPath = joinPaths(config.basePath, path);
  const auth = config.auth || { required: false, strategies: [] };
  const permission = auth.required ? operationId : null;
  routeRegistry.register({ module: "audit", operationId, method: "get", expressPath: fullPath, openApiPath: fullPath, serviceMethod, auth, permissions: permission ? [permission] : [], summary, description: "", tags: ["audit"], deprecated: false});

  const routeHandler = handler({ AuditModel, config, modules, routeRegistry, authContext });
  const handlers = [];
  if (authorize) handlers.push(authorize({ auth, permissions: permission ? [permission] : [] }));
  handlers.push((req, res, next) => { Promise.resolve(routeHandler(req, res, next)).catch(next);});
  mainRouter.get(fullPath, ...handlers);
}

function canViewAuditChange(change, { req, modules, authContext }) {
  const permissions = req.session?.permissions;
  if (!authContext || !Array.isArray(permissions)) return true;

  const mod = moduleForAuditChange(change, modules);
  if (!mod) return false;
  return permissions.includes(`${mod.config.name}.list`);
}

function moduleForAuditChange(change, modules) {
  const tableName = String(change?.tableName || "").toLowerCase();
  if (!tableName) return null;

  for (const mod of modules.values()) {
    const names = [mod.config?.name, mod.config?.resource?.options?.tableName, mod.model?.tableName, mod.model?.modelName, mod.model?.name, ].filter(Boolean).map((name) => String(name).toLowerCase());
    if (names.includes(tableName)) return mod;
  }

  return null;
}

function findAuditModel(modules, models) {
  for (const mod of modules.values()) {
    if (isAuditTableName(mod.config?.name) || isAuditTableName(mod.config?.resource?.options?.tableName)) return mod.model;
  }
  return models.get("audit") || null;
}

function parseSince(value) {
  if (!value) throw new ValidationError("Parametro since requerido", { errors: { since: "Requerido" } });
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new ValidationError("Parametro since invalido", { errors: { since: "Fecha invalida" } });
  return date;
}

function auditSinceField(modules) {
  const auditModule = [...modules.values()].find((mod) => isAuditModule(mod.config));
  return auditModule?.config?.resource?.options?.createdAt || "createdAt";
}

function appendHook(hooks, name, hook) {
  const existing = hooks[name];
  if (!existing) {
    hooks[name] = [hook];
  } else if (Array.isArray(existing)) {
    hooks[name] = [...existing, hook];
  } else {
    hooks[name] = [existing, hook];
  }
}

async function writeAudit(AuditModel, auditConfig, moduleConfig, action, model, oldData, newData, options = {}) {
  const tableName = tableNameFor(moduleConfig);
  if (!tableName || isAuditTableName(tableName)) return;

  const ctx = getContext() || {};
  const audit = ctx.audit || {};
  const auditRow = await AuditModel.create(
    {
      txId: ctx.txId || "",
      clientIp: audit.clientIp || audit.ip || "",
      userId: audit.userId || audit.usuarioId || null,
      tableName,
      rowId: rowId(model, moduleConfig) || rowIdFromWhere(oldData),
      action,
      old: jsonSafe(oldData || {}),
      new: jsonSafe(newData || {}),
    },
    { hooks: false, ...(options.transaction && { transaction: options.transaction }) },
  );
  if (options.emit !== false) auditConfig?.events?.emit("change", auditRow.toJSON(), { transaction: options.transaction });
}

async function findSessionById(adapter, sessionId, options = {}) {
  if (options.transaction && adapter?.models?.Session?.findByPk) {
    const session = await adapter.models.Session.findByPk(sessionId, { transaction: options.transaction });
    if (!session) return null;
    if (typeof session.get === "function") return session.get();
    if (typeof session.toJSON === "function") return session.toJSON();
    return session;
  }
  return adapter.findSessionById(sessionId);
}

function isModelInstance(value) {
  return value && typeof value === "object" && typeof value.toJSON === "function";
}

function snapshot(model) {
  if (!model || typeof model.toJSON !== "function") return {};
  return jsonSafe(model.toJSON());
}

function rowId(model, moduleConfig) {
  if (!model || (typeof model.get !== "function" && typeof model.getDataValue !== "function")) return "";
  const pk = primaryKeyFor(moduleConfig);
  const value = typeof model.get === "function" ? model.get(pk) : model.getDataValue(pk);
  if (value !== undefined && value !== null) return String(value);
  return "";
}

function primaryKeyFor(moduleConfig) {
  const definitions = moduleConfig?.resource?.definition || {};
  return Object.entries(definitions).find(([, definition]) => definition?.primaryKey)?.[0] || "id";
}

function upsertWhereFor(ModelClass, moduleConfig, values = {}, options = {}) {
  if (options.where && typeof options.where === "object" && !Array.isArray(options.where)) return options.where;

  const conflictFields = Array.isArray(options.conflictFields) ? options.conflictFields : [];
  if (conflictFields.length > 0 && conflictFields.every((field) => values[field] !== undefined && values[field] !== null)) {
    return Object.fromEntries(conflictFields.map((field) => [field, values[field]]));
  }

  const pk = ModelClass?.primaryKeyAttribute || primaryKeyFor(moduleConfig);
  if (values[pk] !== undefined && values[pk] !== null) return { [pk]: values[pk] };

  const uniqueFields = uniqueFieldSets(moduleConfig, ModelClass);
  const fields = uniqueFields.find((fieldSet) => fieldSet.every((field) => values[field] !== undefined && values[field] !== null));
  return fields ? Object.fromEntries(fields.map((field) => [field, values[field]])) : null;
}

function uniqueFieldSets(moduleConfig, ModelClass) {
  const definitions = moduleConfig?.resource?.definition || ModelClass?.resourceDefinition?.attributes || ModelClass?.rawAttributes || {};
  const singleFieldSets = Object.entries(definitions)
    .filter(([, definition]) => definition?.unique === true)
    .map(([field]) => [field]);
  const schemaFieldSets = (ModelClass?._schema?.uniqueConstraints || [])
    .map((unique) => unique.columns || unique.fields || [])
    .filter((fields) => fields.length > 0);
  return [...singleFieldSets, ...schemaFieldSets];
}

function rowIdFromWhere(where = {}) {
  if (where.id !== undefined && where.id !== null) return String(where.id);
  return Object.values(where).filter((value) => value !== undefined && value !== null).join("_");
}

function tableNameFor(moduleConfig) {
  return moduleConfig?.resource?.options?.tableName || moduleConfig?.name || "";
}

function isAuditModule(moduleConfig) {
  return isAuditTableName(moduleConfig?.name) || isAuditTableName(moduleConfig?.resource?.options?.tableName) || isAuditTableName(moduleConfig?.resource?.options?.modelName);
}

function jsonSafe(value) {
  if (!value || typeof value !== "object") return {};
  return JSON.parse(JSON.stringify(value));
}

function plainAuditModel(change) {
  return {
    toJSON: () => ({ id: change.rowId, ...(change.new || {}) }),
    get: (key) => (key === "id" ? change.rowId : change.new?.[key]),
    getDataValue: (key) => (key === "id" ? change.rowId : change.new?.[key]),
  };
}

function installAuthRoutes({ mainRouter, routeRegistry, config, authContext }) {
  if (!authContext) return;

  const loginPath = joinPaths(config.basePath, authContext.loginPath);
  const sessionPath = joinPaths(config.basePath, authContext.sessionPath);
  const logoutPath = joinPaths(config.basePath, authContext.logoutPath);

  routeRegistry.register({module: "auth", operationId: "auth.login", method: "post", expressPath: loginPath, openApiPath: loginPath, serviceMethod: "login", auth: { required: false, strategies: [] }, permissions: [], summary: "Login", description: "", tags: ["auth"], deprecated: false});
  routeRegistry.register({module: "auth", operationId: "auth.session", method: "get", expressPath: sessionPath, openApiPath: sessionPath, serviceMethod: "session", auth: { required: true, strategies: authContext.strategies }, permissions: [], summary: "Session", description: "", tags: ["auth"], deprecated: false});
  routeRegistry.register({module: "auth", operationId: "auth.logout", method: "post", expressPath: logoutPath, openApiPath: logoutPath, serviceMethod: "logout", auth: { required: true, strategies: authContext.strategies }, permissions: [], summary: "Logout", description: "", tags: ["auth"], deprecated: false});

  const basePath = normalizeMountPath(config.basePath) || "/";
  const authRouter = express.Router();
  authRouter.post(authContext.loginPath, authContext.middleware);
  authRouter.get(authContext.sessionPath, authContext.middleware);
  authRouter.post(authContext.logoutPath, authContext.middleware);
  mainRouter.use(basePath, authRouter);
}

function createAuthContext(config, authBackend, { auditWriter } = {}) {
  const adapter = authBackend.adapter || new SeqAdapter({ seq: config.seq, models: authBackend.models, auditable: authAuditable(config, authBackend, auditWriter) });
  const rbac = new RBAC({ adapter });
  const middleware = auth(iamAuthOptions(authBackend, adapter));
  return { ...authBackend, adapter, rbac, middleware, models: adapter.models || authBackend.models || null, seq: config.seq};
}

function createAuthorizer(authContext) {
  return ({ auth: auth$1 = { required: false }, permissions = [] } = {}) => {
    if (!auth$1?.required) return (_req, _res, next) => next();
    if (!authContext) return (_req, res) => res.status(401).json({ ok: false, message: "Auth no configurado" });

    const handlers = [
      auth(iamAuthOptions({ ...authContext, ...auth$1 }, authContext.adapter)),
      syncAuthContext,
      ...(permissions || []).filter(Boolean).map((permission) => can(permission)),
      syncAuthContext,
    ];

    return composeMiddlewares(handlers);
  };
}

function setAuthContext(session) {
  const ctx = getContext();
  if (!ctx) return;
  ctx.user = session.user;
  ctx.session = session;
  ctx.audit = { ...(ctx.audit || {}), userId: session.user?.id || null };
}

function syncAuthContext(req, _res, next) {
  if (req.session) {
    req.user = req.session.user;
    setAuthContext(req.session);
  }
  next();
}

function composeMiddlewares(middlewares) {
  return (req, res, next) => {
    let index = 0;
    const run = (error) => {
      if (error) return next(error);
      const middleware = middlewares[index++];
      if (!middleware) return next();
      try {
        return Promise.resolve(middleware(req, res, run)).catch(next);
      } catch (err) {
        return next(err);
      }
    };
    return run();
  };
}

function iamAuthOptions(auth, adapter) {
  return {
    adapter,
    jwt: {
      secret: auth.secret,
      expiresIn: auth.tokenExpiresIn,
    },
    strategies: toIamStrategies(auth.strategies || ["bearer", "basic"]),
    createSession: auth.createSession,
  };
}

function authAuditable(config, authBackend, auditWriter) {
  if (!auditWriter || authBackend.auditable === false) return null;
  return {
    tableName: authBackend.tableNames?.Session || applyNamingConvention("Session", config.seq?.adapter?.naming),
    write: auditWriter,
  };
}

async function installHttpMiddleware(router, config) {
  if (config.trustProxy !== false && config.trustProxy !== undefined) {
    router.use((req, _res, next) => {
      req.app.set("trust proxy", config.trustProxy);
      next();
    });
  }

  const corsOptions = normalizeMiddlewareOptions(config.cors);
  if (corsOptions) {
    const { default: cors } = await import('cors');
    router.use(cors(corsOptions === true ? undefined : corsOptions));
  }

  const helmetOptions = normalizeMiddlewareOptions(config.helmet);
  if (helmetOptions) {
    const { default: helmet } = await import('helmet');
    router.use(helmet(helmetOptions === true ? undefined : helmetOptions));
  }

  const compressionOptions = normalizeMiddlewareOptions(config.compression);
  if (compressionOptions) {
    const { default: compression } = await import('compression');
    router.use(compression(compressionOptions === true ? undefined : compressionOptions));
  }

  const rateLimitOptions = normalizeMiddlewareOptions(config.rateLimit);
  if (rateLimitOptions) {
    const { rateLimit } = await import('express-rate-limit');
    router.use(rateLimit(rateLimitOptions === true ? undefined : rateLimitOptions));
  }

  const jsonOptions = normalizeMiddlewareOptions(config.json);
  if (jsonOptions) router.use(express.json(jsonOptions === true ? undefined : jsonOptions));

  const textOptions = normalizeTextOptions(config.text);
  if (textOptions) router.use(express.text(textOptions));
}

function installOpenApiRoute({ mainRouter, routeRegistry, modules, packageInfo, config, openapi, authorize }) {
  if (!openapi) return;
  const fullPath = joinPaths(config.basePath, openapi.path || "/openapi.json");
  const auth = normalizeRouteAuth(openapi.auth);
  const permissions = openapi.permission ? [openapi.permission] : [];
  routeRegistry.register({ module: "openapi", operationId: "openapi.get", method: "get", expressPath: fullPath, openApiPath: fullPath, serviceMethod: "openapi", auth, permissions, summary: "OpenAPI document", description: "", tags: ["openapi"], deprecated: false});
  const handlers = [];
  if (authorize) handlers.push(authorize({ auth, permissions }));
  handlers.push((_req, res) => {res.json(buildOpenApiDocument({ routes: routeRegistry, modules, packageInfo, config: openapi}));});
  mainRouter.get(fullPath, ...handlers);
}

function installPostmanRoute({ mainRouter, routeRegistry, modules, packageInfo, config, postman, authorize }) {
  if (!postman) return;
  const fullPath = joinPaths(config.basePath, postman.path || "/postman.json");
  const auth = normalizeRouteAuth(postman.auth);
  const permissions = postman.permission ? [postman.permission] : [];
  routeRegistry.register({ module: "openapi", operationId: "postman.get", method: "get", expressPath: fullPath, openApiPath: fullPath, serviceMethod: "postman", auth, permissions, summary: "Postman collection", description: "", tags: ["postman"], deprecated: false});
  const handlers = [];
  if (authorize) handlers.push(authorize({ auth, permissions }));
  handlers.push((_req, res) => {res.json(buildPostmanCollection({ routes: routeRegistry, modules, packageInfo, config: { ...postman, basePath: config.basePath } }));});
  mainRouter.get(fullPath, ...handlers);
}

function normalizeRouteAuth(auth) {
  if (!auth) return { required: false, strategies: [] };
  if (auth === true) return { required: true, strategies: ["bearer", "basic"] };
  const strategies = auth.strategies || auth.strategy || ["bearer", "basic"];
  return { ...auth, required: auth.required ?? true, strategies: Array.isArray(strategies) ? strategies : [strategies] };
}

function installStaticFiles(router, config) {
  for (const staticConfig of config.staticModules) {
    const normalized = normalizeStaticFileConfig(staticConfig, config.baseDir);
    if (!normalized) continue;

    router.use(normalized.mountPath, express.static(normalized.root, normalized.options));
    if (!normalized.spa) continue;

    router.get(new RegExp(`^${escapeRegExp(normalized.mountPath)}(?:/.*)?$`), (req, res, next) => {
      if (/\.[^/]+$/.test(req.path)) return next();
      res.sendFile(path.join(normalized.root, normalized.index));
    });
  }
}

function normalizeStaticFileConfig(config, baseDir) {
  if (!config) return null;
  const value = typeof config === "string" ? { appName: config } : config;
  const mountPath = normalizeMountPath(value.mountPath || value.pathPrefix || (value.appName ? `/${value.appName}` : null));
  const rootInput = value.root || value.dir || value.directory || value.path || (value.appName ? `./public/${value.appName}` : null);
  if (!mountPath || !rootInput) return null;
  return {mountPath, root: path.resolve(baseDir, rootInput), spa: value.spa ?? true, index: value.index || "index.html", options: { redirect: false, ...value.options }};
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function installWelcomeRoute({ mainRouter, routeRegistry, config, packageInfo }) {
  const fullPath = normalizeMountPath(config.basePath) || "/";
  const packageName = packageInfo.name || "api";

  routeRegistry.register({ module: "system", operationId: "system.welcome", method: "get", expressPath: fullPath, openApiPath: fullPath, serviceMethod: "welcome", auth: { required: false, strategies: [] }, permissions: [], summary: "Backend welcome", description: "", tags: ["system"], deprecated: false });

  mainRouter.get(fullPath, (_req, res) => {res.json(ok({ name: packageName, message: `Bienvenido al backend de ${packageName}` }));});
}

function installPingRoute({ mainRouter, routeRegistry, config }) {
  const fullPath = `${normalizeMountPath(config.basePath) || ""}/ping`;

  routeRegistry.register({ module: "system", operationId: "system.ping", method: "get", expressPath: fullPath, openApiPath: fullPath, serviceMethod: "ping", auth: { required: false, strategies: [] }, permissions: [], summary: "Server ping", description: "", tags: ["system"], deprecated: false });

  mainRouter.get(fullPath, (_req, res) => {res.json(ok({ pong: true }));});
}

function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;

  const txId = getContext()?.txId || req.headers["x-transaction-id"] || null;
  const status = err.status || err.statusCode || 500;
  const code = err.type === "entity.parse.failed" ? "INVALID_JSON" : err.code || "INTERNAL_ERROR";
  const errors = err.errors && typeof err.errors === "object" ? err.errors : {};
  const message = status >= 500 && process.env.NODE_ENV === "production" ? "Error interno" : err.message;

  errorLogger(err, req, { txId, status, code, message: err.message, errors, stack: status >= 500 ? err.stack : {} });

  const body = { ok: false, code, message, errors, txId };
  if (process.env.NODE_ENV !== "production") body.stack = err.stack;

  res.status(status).json(body);
}

async function createApi(conf = {}) {
  const auditEvents = new EventEmitter();
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
    auth: conf.auth,
    cors: conf.cors ?? false,
    helmet: conf.helmet ?? false,
    compression: conf.compression ?? false,
    rateLimit: conf.rateLimit ?? false,
    json: conf.json ?? true,
    text: conf.text ?? false,
    staticModules: [],
    trustProxy: conf.trustProxy ?? false,
    audit: normalizeAuditConfig(conf.audit),
    openapi: conf.openapi ?? null,
    postman: conf.postman ?? null,
    logging: conf.logging ?? false,
    sse: conf.sse || { enabled: false },
  };
  setLogging(config.logging || false);
  if (config.audit) config.audit.events = auditEvents;

  validateConfig(config);

  const resolvedPaths = {
    models: path.resolve(config.baseDir, config.paths.models),
    services: path.resolve(config.baseDir, config.paths.services),
    routers: path.resolve(config.baseDir, config.paths.routers),
    schemas: path.resolve(config.baseDir, config.paths.schemas),
  };

  const moduleBundle = await loadModuleBundle(config.modules, config.baseDir);
  config.staticModules.push(...moduleBundle.staticModules);
  config.installableApps = normalizeInstallableApps(config.staticModules, config.baseDir);
  config.auth = normalizeGlobalAuth(config.auth);

  const rawModuleConfigs = moduleBundle.modules;
  const moduleConfigs = normalizeModules(rawModuleConfigs, { basePath: config.basePath, auth: config.auth });
  const authBackend = normalizeAuthBackendConfig(config.auth);
  const auditWriter = createAuditWriter(moduleConfigs, config.audit);
  const authContext = authBackend ? createAuthContext(config, authBackend, { auditWriter }) : null;
  const authorize = createAuthorizer(authContext);

  installAuditHooks(moduleConfigs, config.audit);

  const explicitModels = { ...config.models };
  for (const moduleConfig of moduleConfigs) {
    const resourceModel = moduleConfig.resource?.model;
    const modelName = resourceModel?.modelName || moduleConfig.resource?.options?.modelName || moduleConfig.resource?.model?.name;
    if (modelName && !explicitModels[modelName]) explicitModels[modelName] = resourceModel;
    for (const detailResource of moduleConfig.detailResources || []) {
      const detailModel = detailResource?.model;
      const detailModelName = detailModel?.modelName || detailResource?.options?.modelName || detailModel?.name;
      if (detailModelName && !explicitModels[detailModelName]) explicitModels[detailModelName] = detailModel;
    }
  }

  const modelsMap = await loadModels({seq: config.seq, explicitModels, modelsDir: resolvedPaths.models,moduleConfigs});
  registerSeqModels(config.seq, modelsMap.values());

  const routeRegistry = new RouteRegistry();
  const modules = new Map();
  const services = new Map();
  const models = new Map();
  const schemas = new Map();

  for (const mod of modelsMap) models.set(mod[0], mod[1]);

  for (const moduleConfig of moduleConfigs) {
    const mod = await loadModule({moduleConfig, seq: config.seq, modelsMap, servicesMap: services, routeRegistry, paths: resolvedPaths, authorize});

    modules.set(moduleConfig.name, mod);
    services.set(moduleConfig.name, mod.service);
    schemas.set(moduleConfig.name, mod.schemas);
    if (mod.model) models.set(moduleConfig.name, mod.model);
  }

  const mainRouter = express.Router();
  const packageInfo = await loadPackageInfo(config.baseDir);
  const openapi = normalizeOpenApiConfig(config.openapi);
  const postman = normalizePostmanConfig(config.postman, openapi);

  await installHttpMiddleware(mainRouter, config);
  mainRouter.use(runWithContext);
  mainRouter.use(requestLogger);

  installWelcomeRoute({ mainRouter, routeRegistry, config, packageInfo });
  installPingRoute({ mainRouter, routeRegistry, config });
  installAuthRoutes({ mainRouter, routeRegistry, config, authContext });
  for (const mod of modules.values()) mainRouter.use(mod.mount());
  installAuditChangesRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext });
  const auditSse = installAuditSseRoute({ mainRouter, routeRegistry, modules, models, config, authorize, authContext });
  installFrontendInstallRoutes({ mainRouter, routeRegistry, config, authorize });
  installOpenApiRoute({ mainRouter, routeRegistry, modules, packageInfo, config, openapi, authorize });
  installPostmanRoute({ mainRouter, routeRegistry, modules, packageInfo, config, postman, authorize });
  installStaticFiles(mainRouter, config);

  const app = conf.app || express();
  app.use(mainRouter);
  app.use(errorHandler);

  return {app, router: mainRouter, errorHandler, modules, models, services, routes: routeRegistry, schemas, events: auditEvents, audit: auditSse || { sseClients: () => [] }, auth: authContext, close: async () => { auditEvents.removeAllListeners(); },
  };
}

function registerSeqModels(seq, modelClasses) {
  if (!seq || typeof seq.registerModel !== "function") return;

  for (const modelClass of new Set(modelClasses)) {
    if (!modelClass) continue;
    if (!modelClass.modelName && typeof modelClass.define === "function") modelClass.define(seq);
    const modelName = modelClass.modelName || modelClass.name;
    if (modelName && typeof seq.hasModel === "function" && seq.hasModel(modelName)) continue;
    if (modelClass.modelName) seq.registerModel(modelClass);
  }
}

async function loadPackageInfo(baseDir) {
  try {
    return JSON.parse(await readFile(path.resolve(baseDir, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

class ConflictError extends AppError {
  constructor(message = "Conflicto", { cause = null } = {}) {
    super(message, { status: 409, code: "CONFLICT", cause });
  }
}

class AuthRequiredError extends AppError {
  constructor(message = "Autenticacion requerida", { cause = null, headers = null } = {}) {
    super(message, { status: 401, code: "AUTH_REQUIRED", cause });
    this.headers = headers;
  }
}

class ForbiddenError extends AppError {
  constructor(message = "Acceso denegado", { cause = null } = {}) {
    super(message, { status: 403, code: "FORBIDDEN", cause });
  }
}

class InternalError extends AppError {
  constructor(message = "Error interno", { cause = null } = {}) {
    super(message, { status: 500, code: "INTERNAL_ERROR", cause });
  }
}

export { AppError, AuthRequiredError, BaseModel, BaseModule, BaseRouter, BaseService, ConfigError, ConflictError, ForbiddenError, InternalError, NotFoundError, RouteRegistry, ValidationError, createApi, defineResource, getContext, list, log, ok, requestLogger, runWithContext, setLogging };
//# sourceMappingURL=api-server.js.map
