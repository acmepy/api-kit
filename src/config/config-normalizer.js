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
  const normalized = { ...MODULE_DEFAULTS, ...config, name, basePath: joinPaths(options.basePath, moduleBasePath), endpoints: {}};

  for (const [op, defaults] of Object.entries(ENDPOINT_DEFAULTS)) {
    const userEndpoint = config.endpoints?.[op];
    const disabledByModuleOption = op === "schema" && config.schema === false;
    if (disabledByModuleOption || userEndpoint === false || userEndpoint?.enabled === false) {
      normalized.endpoints[op] = { ...defaults, ...userEndpoint, enabled: false };
    } else if (userEndpoint !== undefined) {
      normalized.endpoints[op] = { ...defaults, ...(typeof userEndpoint === "object" ? userEndpoint : {}), enabled: true };
    } else {
      normalized.endpoints[op] = { ...defaults };
    }
  }

  if (config.endpoints) {
    for (const [key, value] of Object.entries(config.endpoints)) {
      if (!(key in normalized.endpoints)) normalized.endpoints[key] = { method: "get", path: `/${key}`, enabled: true, ...(typeof value === "object" ? value : {})};
    }
  }
  return normalized;
}

export function normalizeModules(configs, options = {}) {
  return configs.map((config) => normalizeModule(config, options));
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

