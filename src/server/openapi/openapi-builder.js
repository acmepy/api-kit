export function buildOpenApiDocument({ routes, modules, packageInfo = {}, config = {} }) {
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

function normalizeStrategies(strategies = []) {
  return strategies.map((strategy) => (strategy === "jwt" ? "bearer" : strategy));
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
    if (jsonSchema) result[name] = jsonSchema;
  }
  return result;
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
