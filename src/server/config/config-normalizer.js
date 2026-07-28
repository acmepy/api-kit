const ENDPOINT_DEFAULTS = {
  list: { enabled: true, method: "get", path: "/", summary: "Listar" },
  schema: { enabled: true, method: "get", path: "/schema", summary: "Schema" },
  get: { enabled: true, method: "get", path: "/:id", summary: "Obtener por ID" },
  create: { enabled: true, method: "post", path: "/", summary: "Crear" },
  update: { enabled: true, method: "put", path: "/:id", summary: "Actualizar" },
  remove: { enabled: true, method: "delete", path: "/:id", summary: "Eliminar" },
};

const MODULE_DEFAULTS = { auth: { required: false, strategies: [] }, tags: [], description: "" };

export function normalizeModule(config, options = {}) {
  const name = config.name;
  if (!name) throw new Error("Module config requires 'name'");

  const moduleBasePath = config.basePath || `/${name}`;
  const auth = normalizeAuth(config.auth === undefined ? options.auth : config.auth);
  const normalized = { ...MODULE_DEFAULTS, ...config, auth, name, basePath: joinPaths(options.basePath, moduleBasePath), endpoints: {}};

  for (const [op, defaults] of Object.entries(ENDPOINT_DEFAULTS)) {
    const userEndpoint = config.endpoints?.[op];
    const disabledByModuleOption = op === "schema" && config.schema === false;
    if (disabledByModuleOption || userEndpoint === false || userEndpoint?.enabled === false) {
      normalized.endpoints[op] = normalizeEndpoint({ ...defaults, ...userEndpoint, enabled: false }, normalized, op);
    } else if (userEndpoint !== undefined) {
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

export function normalizeModules(configs, options = {}) {
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

function joinPaths(...parts) {
  const clean = parts
    .filter((part) => part !== undefined && part !== null && part !== "")
    .map((part) => String(part).trim())
    .filter(Boolean);
  if (clean.length === 0) return "/";
  const path = clean.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  return `/${path}`;
}

