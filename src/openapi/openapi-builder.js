export function buildOpenApiDocument({ routes, modules, packageInfo = {}, config = {} }) {
  const paths = {};
  const schemas = {};

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
    components: {
      schemas,
    },
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
    operationId: route.operationId,
    summary: route.summary || undefined,
    description: route.description || undefined,
    tags: route.tags?.length ? route.tags : [route.module],
    parameters: parametersFor(route),
    responses: responsesFor(route),
  };

  const bodySchemaName = requestBodySchemaName(route);
  if (bodySchemaName && mod?.schemas?.[bodySchemaName]) {
    operation.requestBody = {required: bodySchemaName === "create", content: {"application/json": {schema: { $ref: `#/components/schemas/${componentName(route.module, bodySchemaName)}`}}}};
  }

  return Object.fromEntries(Object.entries(operation).filter(([, value]) => value !== undefined));
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
  if (route.serviceMethod === "list" || route.serviceMethod === "changes") {
    return {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                data: { type: "array", items: { type: "object" } },
                pagination: { type: "object" },
              },
            },
          },
        },
      },
    };
  }

  return {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object" },
            },
          },
        },
      },
    },
    400: { description: "Validation error" },
    404: { description: "Not found" },
  };
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
