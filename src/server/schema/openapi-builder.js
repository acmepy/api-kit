import { normalizeStrategies } from "../utils/normalize.js";
import { jsonSchemaForRoute, normalizeDocumentConfig, routeRequestSchemaName, routesForSession } from "./document-utils.js";

export function normalizeOpenApiConfig(openapi) {
  return normalizeDocumentConfig(openapi, { permission: "schema.list" });
}

export function buildOpenApiDocument({ routes, modules, packageInfo = {}, config = {}, session } = {}) {
  const paths = {};
  const visibleRoutes = routesForSession(routes.getAll(), session);
  const schemas = schemaComponentsForRoutes(modules, visibleRoutes);
  const securitySchemes = securitySchemesFor(visibleRoutes);

  for (const route of visibleRoutes) {
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

export function schemaComponentsForRoutes(modules, routes) {
  const schemas = {};
  const requiredSchemas = new Map();

  for (const route of routes) {
    const schemaName = routeRequestSchemaName(route);
    if (!schemaName) continue;
    if (!requiredSchemas.has(route.module)) requiredSchemas.set(route.module, new Set());
    requiredSchemas.get(route.module).add(schemaName);
  }

  for (const [moduleName, schemaNames] of requiredSchemas) {
    const mod = modules.get(moduleName);
    if (!mod) continue;
    for (const schemaName of schemaNames) {
      const jsonSchema = jsonSchemaForRoute(modules, { module: moduleName }, schemaName);
      if (jsonSchema) schemas[componentName(moduleName, schemaName)] = enrichJsonSchema(jsonSchema, mod, schemaName);
    }
  }

  return schemas;
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

  const bodySchemaName = routeRequestSchemaName(route);
  if (!bodySchemaName || !mod?.schemas?.[bodySchemaName]) return undefined;
  return {required: bodySchemaName === "create", content: {"application/json": {schema: { $ref: `#/components/schemas/${componentName(route.module, bodySchemaName)}`}}}};
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


