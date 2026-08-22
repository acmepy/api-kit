const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

export function normalizePostmanConfig(postman, openapi) {
  if (postman) return postman === true ? {} : postman;
  if (!openapi?.postman) return null;
  return {...openapi,path: openapi.postmanPath || "/postman.json"};
}

export function buildPostmanCollection({ routes, modules = new Map(), packageInfo = {}, config = {} }) {
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
