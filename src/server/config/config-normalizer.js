import { joinPaths } from "../utils/paths.js";

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

export function normalizeModule(config, options = {}) {
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

export function normalizeModules(configs, options = {}) {
  return configs.map((config) => normalizeModule(config, options));
}

function normalizeEndpoint(endpoint, moduleConfig, operation) {
  const auth = normalizeAuth(endpoint.auth === undefined ? moduleConfig.auth : endpoint.auth);
  const permissionOperation = operation === "schema" ? "list" : operation;
  const permission = endpoint.permission === undefined && auth.required ? `${moduleConfig.name}.${permissionOperation}` : endpoint.permission;
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

