const ENDPOINT_DEFAULTS = {
  list: { enabled: true, method: "get", path: "/", summary: "Listar" },
  getById: { enabled: true, method: "get", path: "/:id", summary: "Obtener por ID" },
  create: { enabled: true, method: "post", path: "/", summary: "Crear" },
  update: { enabled: true, method: "put", path: "/:id", summary: "Actualizar" },
  remove: { enabled: true, method: "delete", path: "/:id", summary: "Eliminar" },
};

const MODULE_DEFAULTS = {
  auth: { required: false, strategies: [] },
  tags: [],
  description: "",
};

export function normalizeModule(config) {
  const name = config.name;
  if (!name) throw new Error("Module config requires 'name'");

  const normalized = { ...MODULE_DEFAULTS, ...config, name, basePath: config.basePath || `/api/${name}`, endpoints: {}};

  for (const [op, defaults] of Object.entries(ENDPOINT_DEFAULTS)) {
    const userEndpoint = config.endpoints?.[op];
    if (userEndpoint === false || userEndpoint?.enabled === false) {
      normalized.endpoints[op] = { ...defaults, ...userEndpoint, enabled: false };
    } else {
      normalized.endpoints[op] = { ...defaults, ...userEndpoint, enabled: true };
    }
  }

  if (config.endpoints) {
    for (const [key, value] of Object.entries(config.endpoints)) {
      if (!(key in normalized.endpoints)) {
        normalized.endpoints[key] = { method: "get", path: `/${key}`, enabled: true, ...(typeof value === "object" ? value : {})};
      }
    }
  }

  return normalized;
}

export function normalizeModules(configs) {
  return configs.map(normalizeModule);
}
