import yep from 'yep';

function fillPath(path, params = {}) {
  return path.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(params[key]));
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/g, "");
  const child = String(path || "").replace(/^\/+/g, "");
  if (!base) return `/${child}`;
  if (!child) return base || "/";
  return `${base}/${child}`;
}

function normalizeTimeout(value, fallback) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : fallback;
}

class BaseAdapter {

  async getAll() {
    throw new Error("BaseAdapter.getAll debe implementarse");
  }

  async get() {
    throw new Error("BaseAdapter.get debe implementarse");
  }

  async add() {
    throw new Error("BaseAdapter.add debe implementarse");
  }

  async put() {
    throw new Error("BaseAdapter.put debe implementarse");
  }

  async delete() {
    throw new Error("BaseAdapter.det debe implementarse");
  }

  async clear() {
    throw new Error("BaseAdapter.clear debe implementarse");
  }
}

class MapAdapter extends BaseAdapter {
  #map;

  constructor(map = new Map()) {
    super();
    this.#map = map;
  }

  async getAll() {
    return [...this.#map.values()];
  }

  async get(key) {
    return this.#map.get(key) ?? null;
  }

  async add(value) {
    if(Array.isArray(value)) {
      value.forEach(v => this.put(v.id, v));
      return value;
    }
    this.put(value.id, value);
    return value;
  }

  async put(key, value) {
    this.#map.set(key, value);
    return value;
  }

  async delete(key) {
    return this.#map.delete(key);
  }

  async clear() {
    this.#map.clear();
  }
}

class LocalStorageAdapter extends BaseAdapter {
  #storage;
  #key;
  #data;

  constructor({ storage = globalThis.localStorage, service = "", prefix = "api" } = {}) {
    super();
    if (!storage) throw new Error("LocalStorageAdapter requiere localStorage");
    this.#storage = storage;
    this.#key = service ? `${prefix}:${service}` : prefix;
  }

  async getAll() {
    if(!this.#data) this.#data = JSON.parse(this.#storage.getItem(this.#key) || "[]");
    return this.#data;
  }

  async get(key) {
    return (await this.getAll()).find((item) => item?.id === key) || null;
  }

  async add(value) {
    if (Array.isArray(value)) {
      const records = (await this.getAll()).filter((item) => !value.some((nextItem) => nextItem?.id === item?.id));
      const nextRecords = [...records,...value];
      this.#storage.setItem(this.#key, JSON.stringify(nextRecords));
      this.#data = undefined;
      return value;
    }
    await this.put(value.id, value);
    return value;
  }

  async put(key, value) {
    const records = await this.getAll();
    const nextRecords = [...records.filter((item) => item?.id !== key), value];
    this.#storage.setItem(this.#key, JSON.stringify(nextRecords));
    this.#data = undefined;
    return value;
  }

  async delete(key) {
    const records = await this.getAll();
    const nextRecords = records.filter((item) => item?.id !== key);
    this.#storage.setItem(this.#key, JSON.stringify(nextRecords));
    this.#data = undefined;
  }

  async clear() {
    this.#data = undefined;
    this.#storage.removeItem(this.#key);
  }
}

class IndexedDbAdapter extends BaseAdapter {
  #dbName;
  #storeName;
  #indexedDB;
  #dbPromise = null;

  constructor(options = {}) {
    super();
    this.#indexedDB = options.indexedDB || globalThis.indexedDB;
    if (!this.#indexedDB) throw new Error("IndexedDbAdapter requiere indexedDB");
    this.#dbName = options.dbName || "api";
    this.#storeName = options.storeName || "session";
  }

  async get(key) {
    return this.#transaction("readonly", (store) => store.get(key));
  }

  async set(key, value) {
    await this.#transaction("readwrite", (store) => store.put(value, key));
  }

  async remove(key) {
    await this.#transaction("readwrite", (store) => store.delete(key));
  }

  async #transaction(mode, action) {
    const db = await this.#db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.#storeName, mode);
      const request = action(tx.objectStore(this.#storeName));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  #db() {
    if (this.#dbPromise) return this.#dbPromise;
    this.#dbPromise = new Promise((resolve, reject) => {
      const request = this.#indexedDB.open(this.#dbName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(this.#storeName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.#dbPromise;
  }
}

function createAdapter({ type, prefix = "api", service, ...options } = {}) {
  if (type === "localStorage") return new LocalStorageAdapter({ ...options, prefix, service });
  if (type === "indexedDB" || type === "indexdb") return new IndexedDbAdapter(options);
  return new MapAdapter();
}

function defaultAdapter(options = {}) {
  const { storage, ...adapterOptions } = options;
  const storageType = typeof storage === "string" ? storage : undefined;
  const storageOption = storageType ? {} : { storage };
  return createAdapter({
    ...adapterOptions,
    ...storageOption,
    type: options.type || storageType,
    prefix: options.prefix || "api",
  });
}

let temporaryStorage;

class BaseService {
  constructor({ client, name, path, operations = {}, schemas = {}, prefix = "api", createAdapter }) {
    this.client = client;
    this.name = name;
    this.path = path;
    this.operations = operations;
    //this.schemas = schemas;
    this.prefix = prefix;
    this.adapter = createAdapter?.({ service: name, prefix: this.prefix });
  }

  async list() {
    return { ok: true, data: await this.adapter.getAll() };
  }

  async pending() {
    const result = await this.list();
    return { ...result, data: result.data.filter((record) => record?.pending) };
  }

  async get(id) {
    const data = await this.adapter.get(id);
    return { ok: Boolean(data), data };
  }

  async create(data = {}, options = {}) {
    const record = await this.validate(data, "create");
    const pending = options.pending ?? !this.client.connected?.();
    if (!pending) {
      const response = await this.#send("create", { body: record });
      if (response.data) await this.adapter.add(response.data);
      this.#notify();
      return response;
    }
    data = {...record, id: record.id ?? await this.nextTemporaryId(), pending: true, operation:'create', status: "pending", message: "", errors: null };
    await this.adapter.add(data);
    this.#notify();
    this.#throwPushError(await this.pushOne(data));
    return { ok: true, data };
  }

  async update(id, data = {}, options = {}) {
    const current = await this.adapter.get(id);
    const record = await this.validate({...current, ...data, id}, "update");
    const pending = options.pending ?? !this.client.connected?.();
    if(!pending) {
      const response = await this.#send("update", { params: { id }, body: data });
      const nextRecord = response.data || record;
      await this.adapter.put(nextRecord.id ?? id, nextRecord);
      this.#notify();
      return response;
    }
    data = {...current, ...data, pending: true, operation:'update', status: "pending", message: "", errors: null };
    await this.adapter.put(data.id ?? id, data);
    this.#notify();
    const ret = await this.pushOne(data);
    if(!ret.ok) throw ret;
    return { ok: true, data };
  }

  async remove(id, options = {}) {
    const current = await this.adapter.get(id);
    const pending = options.pending ?? !this.client.connected?.();
    if (!pending) {
      const response = await this.#send("remove", { params: { id } });
      await this.adapter.delete(id);
      this.#notify();
      return response;
    }
    const data = {...current, id, pending: true, operation:'remove', status: "pending", message: "", errors: null };
    await this.adapter.put(data.id, data);
    this.#notify();
    this.#throwPushError(await this.pushOne(data));
    return { ok: true, data };
  }

  async pull(query = {}) {
    const records = [];
    let nextQuery = { ...query };

    while (nextQuery) {
      const response = await this.#send("list", { query: nextQuery });
      const data = Array.isArray(response.data) ? response.data : [];
      records.push(...data);
      nextQuery = this.#nextPageQuery(response, nextQuery);
    }

    if (records.length > 0) await this.adapter.add(records);
    await this.client.markServiceCacheUpdated?.(this.name);
    this.#notify();
    return { ok: true, data: records };
  }

  async pullOne(id, query = {}) {
    const response = await this.#send("get", { params: { id }, query });
    if (response.data?.id !== undefined) {
      await this.adapter.add(response.data);
      this.#notify();
    }
    return response;
  }

  async applyData(data) {
    if (!data || typeof data !== "object") return;
    const action = String(data.action || data.type || "").toLowerCase();
    const isCreate = action === "create" || action === "bulk-create";
    const isUpdate = action === "update" || action === "bulk-update";
    if (isCreate || isUpdate) {
      const changes = data.new && typeof data.new === "object" ? { ...data.new } : null;
      if (!changes) return;
      const current = await this.#recordForChange(data, changes.id);
      const id = current?.id ?? changes.id ?? data.rowId ?? data.id ?? data.old?.id;
      if (id === undefined || id === null) return;
      const record = isUpdate ? { ...current, ...changes, id } : { ...changes, id };
      await this.adapter.put(id, record);
      this.#notify();
      return;
    }
    if (action === "delete" || action === "bulk-delete" || action === "remove" || action === "bulk-remove") {
      const current = await this.#recordForChange(data);
      const id = current?.id ?? data.old?.id ?? data.rowId ?? data.id;
      if (id === undefined || id === null) return;
      await this.adapter.delete(id);
      this.#notify();
      return;
    }
  }

  async nextTemporaryId() {
    if (!temporaryStorage) temporaryStorage = defaultAdapter({ prefix: this.prefix, service: "temporaryKey" });
    const record = await temporaryStorage.get("temporaryKey");
    const value = Number(record?.value || 0) + 1;
    await temporaryStorage.put("temporaryKey", { id: "temporaryKey", value });
    return value;
  }

  async push(id = null) {
    const targets = id === null ? (await this.pending()).data : [await this.adapter.get(id)].filter(Boolean);
    const results = [];
    for (const record of targets) results.push(await this.pushOne(record));
    const errors = results.filter((result) => !result.ok);
    return { ok: errors.length === 0, results, errors };
  }

  async pushOne(record) {
    try {
      const response = await this.#sendPendingOperation(record);
      if (record.operation === "create") await this.adapter.delete(record.id);
      this.#notify();
      return { ok: true, id: record.id, operation: record.operation, response };
    } catch (error) {
      const errors = error.errors || error.response?.errors || null;
      const nextRecord = {...record, pending: true, status: "error", message: error.message, errors};
      await this.adapter.put(record.id, nextRecord);
      this.#notify();
      return { ok: false, id: record.id, operation: record.operation, error: error.message, errors };
    }
  }

  async schema() {
    return this.request("schema");
  }

  async validate(data = {}, operation = "create") {
    const schema = await this.#yepSchema(operation);
    if (!schema) return data;
    return schema.validate(data);
  }

  async validateAt(attribute, data = {}, operation = "create") {
    const schema = await this.#yepSchema(operation);
    if (!schema) return data?.[attribute];
    return schema.validateAt(attribute, data);
  }

  async unique(field, value, data = {}) {
    if (value === undefined || value === null) return null;
    const currentId = data?.id;
    const records = (await this.list()).data;
    const duplicate = records.find((record) => (
      record?.[field] === value && (currentId === undefined || String(record.id) !== String(currentId))
    ));
    return duplicate ? new Error("Ya existe un registro con este valor") : null;
  }

  permissions(operation) {
    return [...(this.operations[operation]?.permissions || [])];
  }

  async request(operationName, { params = {}, query = {}, body } = {}) {
    return this.#send(operationName, { params, query, body });
  }

  async #send(operationName, { params = {}, query = {}, body } = {}) {
    const operation = this.operations[operationName];
    if (!operation) throw new Error(`Operacion "${operationName}" no disponible en "${this.name}"`);
    return this.client.request(fillPath(operation.path, params), { method: operation.method, query, body });
  }

  async clear() {
    await this.adapter.clear();
    this.#notify();
  }

  #notify() {
    this.client.notifyChange?.({ service: this.name });
  }

  async #recordForChange(data, preferredId) {
    const id = preferredId ?? data.rowId ?? data.id ?? data.old?.id;
    if (id === undefined || id === null) return null;
    const direct = await this.adapter.get(id);
    if (direct) return direct;
    return (await this.adapter.getAll()).find((record) => String(record?.id) === String(id)) || null;
  }

  async #sendPendingOperation(record) {
    if (record.operation === "create") return this.#send("create", { body: this.#pendingBody(record) });
    if (record.operation === "update") return this.#send("update", { params: { id: record.id }, body: this.#pendingBody(record) });
    if (record.operation === "remove") return this.#send("remove", { params: { id: record.id } });
    throw new Error(`Operacion pendiente "${record.operation}" no soportada`);
  }
/*
  async #applyPushedRecord(record, response) {
    if (record.operation === "remove") {
      await this.adapter.delete(record.id);
      return;
    }

    const data = response.data || this.#pendingBody(record);
    await this.adapter.put(data.id ?? record.id, {...data,pending: false,status: "synced",message: "",errors: null});
    if (data.id !== undefined && String(data.id) !== String(record.id)) await this.adapter.delete(record.id);
  }
*/
  #pendingBody(record) {
    const { pending, operation, status, message, errors, ...body } = record;
    return body;
  }

  #throwPushError(result) {
    if (result.ok) return;
    const error = new Error(result.error);
    error.errors = result.errors || null;
    error.response = result;
    throw error;
  }

  async #yepSchema(operation) {
    if (!this.schemas) {
      if (typeof this.client.service !== "function") return null;
      const { id, ...schemas } = (await this.client.service("schema").get(this.name))?.data || {};
      this.schemas = schemas;
    }
    const jsonSchema = this.schemas?.[operation];
    if (!jsonSchema) return null;
    const schema = yep.fromJsonSchema(jsonSchema);
    this.#applyUniqueRules(schema, jsonSchema);
    return schema;
  }

  #applyUniqueRules(schema, jsonSchema) {
    for (const [field, property] of Object.entries(jsonSchema?.properties || {})) {
      if (property?.unique !== true || typeof schema.shapeDefinition?.[field]?.unique !== "function") continue;
      schema.shapeDefinition[field].unique((value, attribute, data) => this.unique(attribute, value, data));
    }
  }


  #nextPageQuery(response, query) {
    const pagination = response.pagination || response.meta?.pagination || response.meta || {};
    const next = pagination.next || pagination.nextPage || response.next || response.links?.next;

    if (typeof next === "object") return { ...query, ...next };
    if (typeof next === "number") return { ...query, page: next };
    if (typeof next === "string") return { ...query, page: next };

    const page = Number(query.page || pagination.page || 1);
    const totalPages = Number(pagination.totalPages || pagination.pages || 0);
    if (pagination.hasNextPage || (totalPages && page < totalPages)) return { ...query, page: page + 1 };

    return null;
  }

}

class ApiClientError extends Error {
  constructor(message, { status = 0, response = null } = {}) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.response = response;
    this.errors = response?.errors || null;
    this.code = response?.code || null;
  }
}

function encodeBody(body, headers) {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (typeof FormData !== "undefined" && body instanceof FormData) return body;
  headers["Content-Type"] = headers["Content-Type"] || "application/json";
  return JSON.stringify(body);
}

const INTERNAL_SERVICES = new Set(["audit", "auth", "openapi", "postman", "session", "schema", "pending", "system", "install"]);

function discoverServiceDescriptors(openapi, baseUrl = "") {
  const byName = new Map();
  const pathPrefix = String(baseUrl || "").replace(/\/+$/g, "");

  for (const [path, methods] of Object.entries(openapi?.paths || {})) {
    for (const [method, operation] of Object.entries(methods || {})) {
      const serviceName = operation.tags?.[0];
      const serviceMethod = serviceMethodFor(operation.operationId, serviceName);
      if (!serviceName || !serviceMethod || INTERNAL_SERVICES.has(serviceName)) continue;
      const clientPath = pathPrefix && path.startsWith(`${pathPrefix}/`) ? path.slice(pathPrefix.length) : path;
      if (!byName.has(serviceName)) byName.set(serviceName, { name: serviceName, path: clientPath, operations: {} });
      const descriptor = byName.get(serviceName);
      descriptor.operations[serviceMethod] = {method: method.toUpperCase(), path: clientPath, permissions: operation["x-permissions"] || []};
    }
  }
  return [...byName.values()];
}

function serviceMethodFor(operationId = "", serviceName = "") {
  const normalized = String(operationId).replace(`${serviceName}_`, `${serviceName}.`);
  const method = normalized.split(/[._-]/).pop();
  if (["list", "get", "schema", "create", "update", "remove", "changes", "sse"].includes(method)) return method;
  return method || null;
}

class OpenapiService extends BaseService {
  constructor({ client, prefix, createAdapter, path = "/openapi.json" }) {
    super({ client, name: "openapi", path, operations: {}, schemas: {}, prefix, createAdapter });
  }

  async list() {
    throw new Error("OpenapiService.list no implementado");
  }

  async create(data = {}) {
    throw new Error("OpenapiService.list no implementado");
  }

  async update() {
    throw new Error("OpenapiService.update no implementado");
  }

  async remove() {
    throw new Error("OpenapiService.remove no implementado");
  }

  async pull() {
    const records = await this.client.request(this.path, { method: "GET", cache: "no-store" });
    await this.adapter.clear();
    await this.adapter.put("document", records);
    return records;
  }

  async pullOne() {
    throw new Error("OpenapiService.pullOne no implementado");
  }

  async push() {
    throw new Error("OpenapiService.push no implementado");
  }

  async schema() {
    throw new Error("OpenapiService.schema no implementado");
  }

  async loadSchema() {
    throw new Error("OpenapiService.loadSchema no implementado");
  }

  async validate() {
    throw new Error("OpenapiService.validate no implementado");
  }

  async validateAt() {
    throw new Error("OpenapiService.validateAt no implementado");
  }

  async request() {
    throw new Error("OpenapiService.request no implementado");
  }

  permissions() {
    throw new Error("OpenapiService.permissions no implementado");
  }

}

class PendingService extends BaseService {
  constructor({ client, prefix }) {
    super({ client, name: "pending", path: "", operations: {}, schemas: {}, prefix });
  }

  async list() {
    const pending = [];
    for (const service of this.client.services().values()) {
      if (service === this || ["session", "openapi", "schema"].includes(service.name) || typeof service.pending !== "function") continue;
      const result = await service.pending();
      pending.push(...(result.data || []));
    }
    return { ok: true, data: pending };
  }

  async get() {
    throw new Error("PendingService.get no implementado");
  }

  async create() {
    throw new Error("PendingService.create no implementado");
  }

  async update() {
    throw new Error("PendingService.update no implementado");
  }

  async remove() {
    throw new Error("PendingService.remove no implementado");
  }

  async pull() {
    throw new Error("PendingService.pull no implementado");
  }

  async pullOne() {
    throw new Error("PendingService.pullOne no implementado");
  }

  async push() {
    throw new Error("PendingService.push no implementado");
  }

  async nextTemporaryId() {
    throw new Error("PendingService.nextTemporaryId no implementado");
  }

  async clear() {
    return null;
  }
}

class SchemaService extends BaseService {
  constructor({ client, prefix, createAdapter }) {
    super({ client, name: "schema", path: "", operations: {}, schemas: {}, prefix, createAdapter });
  }

  async create(data = {}) {
    throw new Error("SchemaService.list no implementado");
  }

  async list() {
    throw new Error("SchemaService.list no implementado");
  }

  async update(name, data = {}) {
    return { ok: true, data: await this.adapter.put(name, { id: name, ...data }) };
  }

  async remove() {
    throw new Error("SchemaService.remove no implementado");
  }

  async pull() {
    throw new Error("SchemaService.pull no implementado");
  }

  async pullOne() {
    throw new Error("SchemaService.pullOne no implementado");
  }

  async push() {
    throw new Error("SchemaService.push no implementado");
  }

  async schema() {
    throw new Error("SchemaService.schema no implementado");
  }

  async loadSchema() {
    throw new Error("SchemaService.loadSchema no implementado");
  }

  async validate() {
    throw new Error("SchemaService.validate no implementado");
  }

  async validateAt() {
    throw new Error("SchemaService.validateAt no implementado");
  }

  async request() {
    throw new Error("SchemaService.request no implementado");
  }

  permissions() {
    throw new Error("SchemaService.permissions no implementado");
  }
}

class SessionService extends BaseService {
  constructor({ client, prefix, createAdapter, path = "/session" }) {
    super({client, name: "session", path, operations: { pull: { path, method: "GET" } }, schemas: {}, prefix, createAdapter,});
  }

  async list() {
    const session = await this.adapter.get("session");
    return { ok: true, data: session };
  }

  async pull() {
    const response = await this.client.request(this.path, { method: "GET" });
    await this.adapter.clear();
    if (response.data) await this.adapter.add(response.data);
    return response;
  }

  async get() {
    throw new Error("SessionService.get no implementado");
  }

  async create(data) {
    await this.adapter.clear();
    if (data) await this.adapter.add(data);
    return { ok: true, data };
  }

  async update() {
    throw new Error("SessionService.update no implementado");
  }

  async remove() {
    throw new Error("SessionService.remove no implementado");
  }

  async pullOne() {
    throw new Error("SessionService.pullOne no implementado");
  }

  async push() {
    throw new Error("SessionService.push no implementado");
  }

  async nextTemporaryId() {
    throw new Error("SessionService.nextTemporaryId no implementado");
  }

  async schema() {
    throw new Error("SessionService.schema no implementado");
  }

  async validate() {
    throw new Error("SessionService.validate no implementado");
  }

  async validateAt() {
    throw new Error("SessionService.validateAt no implementado");
  }

  permissions() {
    throw new Error("SessionService.permissions no implementado");
  }

  async pending() {
    throw new Error("SessionService.pending no implementado");
  }
}

const DEFAULT_PREFIX = "api";
const DEFAULT_SESSION_KEY = `${DEFAULT_PREFIX}:session`;
const DEFAULT_PING_INTERVAL = 5000;
const DEFAULT_PING_TIMEOUT = 3000;
const DEFAULT_SSE_WATCHDOG_TIMEOUT = 25000;
const DEFAULT_SYNC_CACHE_TIMEOUT = 5 * 60 * 1000;

function normalizeCacheTimeout(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout >= 0 ? timeout : fallback;
}

function createApiClient(options = {}) {
  return new ApiClient(options);
}

class ApiClient {
  #host;
  #baseUrl;
  #fetch;
  #adapter;
  #createAdapter;
  #prefix;
  #sessionKey;
  #session = null;
  #services = new Map();
  #openapi = null;
  #listeners = new Set();
  #online = false;
  #lastReceivedAt = null;
  #syncServicesPromise = null;
  #backgroundSyncPromise = null;
  #backgroundServiceSyncs = new Map();
  #cachedRequests = new Map();
  #changesPromise = null;
  #pingTimer = null;
  #pingAbort = null;
  #pingPromise = null;
  #sseAbort = null;
  #sseReader = null;
  #sseOpenPromise = null;
  #watchdogTimer = null;
  #pingInterval;
  #pingTimeout;
  #sseWatchdogTimeout;
  #syncCacheTimeout;
  #changesEnabled;
  #sseEnabled;
  #paths;

  constructor(options = {}) {
    const url = new URL(options.url || "http://localhost:3000/api");
    this.#host = url.origin;
    this.#baseUrl = url.pathname.replace(/\/+$/g, "");
    this.#fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    this.#adapter = options.adapter || defaultAdapter(options);
    this.#createAdapter = options.createAdapter || ((adapterOptions = {}) => defaultAdapter({ ...options, ...adapterOptions }));
    this.#prefix = options.prefix || DEFAULT_PREFIX;
    this.#sessionKey = options.sessionKey || (this.#prefix === DEFAULT_PREFIX ? DEFAULT_SESSION_KEY : `${this.#prefix}:session`);
    this.#services.set("pending", new PendingService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter }));
    this.#pingInterval = normalizeTimeout(options.pingInterval ?? options.pingIntervalMs, DEFAULT_PING_INTERVAL);
    this.#pingTimeout = normalizeTimeout(options.pingTimeout ?? options.pingTimeoutMs, DEFAULT_PING_TIMEOUT);
    this.#sseWatchdogTimeout = normalizeTimeout(options.sseWatchdogTimeout ?? options.sseWatchdogTimeoutMs, DEFAULT_SSE_WATCHDOG_TIMEOUT);
    this.#syncCacheTimeout = normalizeCacheTimeout(options.syncCacheTimeout, DEFAULT_SYNC_CACHE_TIMEOUT);
    this.#changesEnabled = options.changes !== false;
    this.#sseEnabled = options.sse !== false;
    this.#paths = {
      login: options.loginPath || "/login",
      logout: options.logoutPath || "/logout",
      session: options.sessionPath || "/session",
      ping: options.pingPath || "/ping",
      openapi: options.openapiPath || "/openapi.json",
      changes: options.changesPath || "/changes",
      sse: options.ssePath || "/sse",
    };

    if (!this.#fetch) throw new Error("ApiClient requiere fetch");
    queueMicrotask(() => this.#startPing());
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  get adapter() {
    return this.#adapter;
  }

  async login(credentials = {}) {
    const response = await this.request(this.#paths.login, { method: "POST", body: credentials, auth: false });
    await this.sessionService().create(response.data || null);
    this.#onLine("login", response.data);

    await this.syncServices();
    if (this.#changesEnabled) await this.changes();
    this.#stopPing();
    if (this.#sseEnabled) await this.#openSse();
    return response;
  }

  async logout() {
    const response = await this.request(this.#paths.logout, { method: "POST" });
    await this.#clearServices();
    this.#stopPing();
    this.#closeSse();
    this.#clearWatchdog();
    this.#offLine("logout", response.data);
    this.#startPing();
    return response;
  }

  sessionService(){
    if (!this.#services.has("session")) this.#services.set('session', new SessionService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter, path: this.#paths.session }));    
    return this.service("session")
  }
  async session() {
    const session = (await this.sessionService().adapter.getAll())[0] || {};
    if (session?.token && !this.#syncServicesPromise) await this.syncServices();
    return session;
  }

  async #expireSession(error) {
    await this.#clearServices();
    this.#stopPing();
    this.#closeSse();
    this.#clearWatchdog();
    this.#offLine("auth-expired", error?.response || null);
    this.#startPing();
  }

  async token() {
    return (await this.session())?.token || null;
  }

  service(name) {
    const service = this.#services.get(name);
    if (!service) throw new Error(`Servicio "${name}" no descubierto`);
    return service;
  }

  services() {
    return new Map(this.#services);
  }

  async cachedRequest(key, path, { force = false, ...options } = {}) {
    const cacheKey = `cache:${key}`;
    const cached = await this.#adapter.get(cacheKey);
    if (!force && cached && Object.hasOwn(cached, "data")) {
      const response = { ok: true, data: cached.data, cached: true };
      if (!this.#isSyncCacheFresh(cached)) response.refresh = this.#refreshCachedRequest(cacheKey, path, options);
      return response;
    }
    return this.#refreshCachedRequest(cacheKey, path, options);
  }

  async markServiceCacheUpdated(name) {
    const id = this.#serviceCacheKey(name);
    await this.#adapter.put(id, { id, lastUpdateAt: new Date().toISOString() });
  }

  async syncServices(force = false) {
    if (this.#syncServicesPromise) return this.#syncServicesPromise;
    if (!force && this.#services.get("openapi")) return;

    const sync = this.#synchronizeServices(force);
    this.#syncServicesPromise = sync;
    try {
      return await sync;
    } finally {
      if (this.#syncServicesPromise === sync) this.#syncServicesPromise = null;
    }
  }

  async #synchronizeServices(force) {
    const openapiService = new OpenapiService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter, path: this.#paths.openapi });
    this.#services.set("openapi", openapiService);
    const cachedOpenapi = await this.#cachedOpenapi(openapiService);
    const cacheMetadata = await openapiService.adapter.get("metadata");

    if (!force && cachedOpenapi && this.#isSyncCacheFresh(cacheMetadata)) {
      await this.#registerServices(cachedOpenapi);
      return;
    }

    if (!force && cachedOpenapi && cacheMetadata) {
      await this.#registerServices(cachedOpenapi);
      if (this.#online) this.#refreshServicesInBackground(openapiService);
      return;
    }

    await this.#refreshServices(openapiService, force, cachedOpenapi);
  }

  async #refreshServices(openapiService, force, fallbackOpenapi = null) {
    let openapi;
    try {
      if(!this.#online) throw Error('OffLine')
      openapi = await openapiService.pull();
    } catch (error) {
      if (error.status === 401){
        await this.#expireSession(error);
        throw error;
      }else {
        openapi = fallbackOpenapi || await this.#cachedOpenapi(openapiService);
      }
    }

    await this.#registerServices(openapi, { refreshSchemas: Boolean(openapi), force });
    if (openapi && openapi !== fallbackOpenapi) {
      await openapiService.adapter.put("metadata", { id: "metadata", lastUpdateAt: new Date().toISOString() });
    }
  }

  #refreshServicesInBackground(openapiService) {
    if (this.#backgroundSyncPromise) return;
    const refresh = this.#refreshServices(openapiService, false)
      .catch((error) => {
        if (error?.status !== 401) console.error("api-client, syncServices", error);
      })
      .finally(() => {
        if (this.#backgroundSyncPromise === refresh) this.#backgroundSyncPromise = null;
      });
    this.#backgroundSyncPromise = refresh;
  }

  #refreshServiceInBackground(service) {
    if (this.#backgroundServiceSyncs.has(service.name)) return;
    const refresh = service.pull()
      .catch((error) => {
        if (error?.status !== 401) console.error("api-client, service refresh", service.name, error);
      })
      .finally(() => this.#backgroundServiceSyncs.delete(service.name));
    this.#backgroundServiceSyncs.set(service.name, refresh);
  }

  #serviceCacheKey(name) {
    return `sync:${name}`;
  }

  async #isServiceCacheFresh(name) {
    return this.#isSyncCacheFresh(await this.#adapter.get(this.#serviceCacheKey(name)));
  }

  #refreshCachedRequest(cacheKey, path, options) {
    if (this.#cachedRequests.has(cacheKey)) return this.#cachedRequests.get(cacheKey);
    const refresh = this.request(path, options)
      .then(async (response) => {
        await this.#adapter.put(cacheKey, { id: cacheKey, data: response.data, lastUpdateAt: new Date().toISOString() });
        return response;
      })
      .finally(() => this.#cachedRequests.delete(cacheKey));
    this.#cachedRequests.set(cacheKey, refresh);
    return refresh;
  }

  async #cachedOpenapi(openapiService) {
    const document = await openapiService.adapter.get("document");
    if (document) return document;
    return (await openapiService.adapter.getAll()).find((record) => record?.openapi) || null;
  }

  #isSyncCacheFresh(metadata) {
    const updatedAt = Date.parse(metadata?.lastUpdateAt || "");
    return Number.isFinite(updatedAt) && Date.now() - updatedAt < this.#syncCacheTimeout;
  }

  async #registerServices(openapi, { refreshSchemas = false, force = false } = {}) {
    const schemaService = new SchemaService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter });
    this.#services.set("schema", schemaService);

    for (const descriptor of discoverServiceDescriptors(openapi, this.#baseUrl)) {
      if (!descriptor.operations.list) continue;
      const service = new BaseService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter, ...descriptor });
      this.#services.set(descriptor.name, service);
      try{
        if (refreshSchemas && descriptor.operations.schema) {
          const response = await service.schema();
          await schemaService.update(descriptor.name, response.data || response);
        }
        if (force) await service.pull();
        else if (!(await this.#isServiceCacheFresh(descriptor.name))) this.#refreshServiceInBackground(service);
      }catch(e){
        if (e?.status === 401) {
          await this.#expireSession(e);
          throw e;
        }
        if (![404, 405].includes(e?.status) && e?.message !== "Schema disabled") console.error('api-client, syncServices', e);
      }
    }
  }

  connected() {
    return this.#online;
  }

  lastReceivedAt() {
    return this.#lastReceivedAt;
  }

  destroy() {
    this.#stopPing();
    this.#closeSse();
    this.#clearWatchdog();
    this.#listeners.clear();
  }

  disconnect() {
    this.destroy();
  }

  onChange(listener) {
    if (typeof listener !== "function") throw new TypeError("listener debe ser una funcion");
    this.#listeners.add(listener);
    return () => this.offChange(listener);
  }

  offChange(listener) {
    this.#listeners.delete(listener);
  }

  notifyChange(event = {}) {
    this.#emitChange({ type: "cache", ...event });
  }

  async changes(since) {
    if (this.#changesPromise) return this.#changesPromise;

    const changes = this.#requestChanges(since);
    this.#changesPromise = changes;
    try {
      return await changes;
    } finally {
      if (this.#changesPromise === changes) this.#changesPromise = null;
    }
  }

  async #requestChanges(since) {
    const requestedSince = since ? this.#normalizeDateTime(since) : this.#lastReceivedAt || this.#now();
    const query = { since: requestedSince };
    let response;
    try {
      response = await this.request(this.#paths.changes, { query });
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) await this.#expireSession(error);
      throw error;
    }
    const receivedAt = this.#touchLastReceivedAt();
    await this.#applyChangesData(response.data);
    this.#onLine("changes", response.data, { lastReceivedAt: receivedAt });
    this.#emitChange({ type: "changes", data: response.data, lastReceivedAt: receivedAt });
    return response;
  }

  async request(path, options = {}) {
    const url = this.url(path, options.query);
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    const body = encodeBody(options.body, headers);
    const token = options.token || await this.token() || null;
    if (options.requireToken && !token) throw new ApiClientError("Sesion local requerida", { status: 401 });
    if (options.auth !== false && token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await this.#fetch(url, { method: options.method || "GET", headers, body, signal: options.signal, cache: options.cache });
    } catch (error) {
      const payload = { ok: false, message: error.message || "Error de red", error };
      throw new ApiClientError(payload.message, { response: payload });
    }
    const contentType = response.headers?.get?.("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok || payload?.ok === false){
      throw new ApiClientError(payload?.message || response.statusText, { status: response.status, response: payload });
    }

    return payload;
  }

  url(path, query = {}) {
    const url = new URL(joinUrl(joinUrl(this.#host, this.#baseUrl), path));
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async #ping() {
    if (this.#pingPromise) return this.#pingPromise;

    const ping = this.#runPing();
    this.#pingPromise = ping;
    try {
      return await ping;
    } finally {
      if (this.#pingPromise === ping) this.#pingPromise = null;
    }
  }

  async #runPing() {
    const controller = new AbortController();
    this.#pingAbort = controller;
    const timeout = setTimeout(() => controller.abort(), this.#pingTimeout);
    timeout.unref?.();
    try {
      await this.#pingRequest(controller.signal);
    } catch {
      this.#offLine("ping");
      if (this.#pingAbort === controller) this.#pingAbort = null;
      clearTimeout(timeout);
      return;
    }

    try {
      const localSession = await this.session() || null;
      if (!localSession?.token) throw new ApiClientError("Sesion local requerida", { status: 401 });
      await this.syncServices();
      if (this.#changesEnabled) await this.changes();
      this.#stopPing();
      if (this.#sseEnabled) await this.#openSse();
    } catch {
      this.#closeSse();
    } finally {
      if (this.#pingAbort === controller) this.#pingAbort = null;
      clearTimeout(timeout);
    }
  }

  async #pingRequest(signal) {
    const response = await this.request(this.#paths.ping, { method: "GET", auth: false, signal });
    this.#onLine("ping", response.data);
    return response;
  }

  #startPing() {
    if (this.#pingTimer) return;
    this.#pingTimer = setInterval(() => {this.#ping();}, this.#pingInterval);
    this.#pingTimer.unref?.();
    this.#ping();
  }

  #stopPing() {
    const abort = this.#pingAbort;
    this.#pingAbort = null;
    abort?.abort();
    if (!this.#pingTimer) return;
    clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  async #openSse() {
    if (!this.#sseEnabled) return;
    if (this.#sseAbort) return;

    if (this.#sseOpenPromise) return this.#sseOpenPromise;

    const opening = this.#startSse();
    this.#sseOpenPromise = opening;
    try {
      return await opening;
    } finally {
      if (this.#sseOpenPromise === opening) this.#sseOpenPromise = null;
    }
  }

  async #startSse() {
    if (!(await this.token())) return;
    if (this.#sseAbort) return;
    const controller = new AbortController();
    this.#sseAbort = controller;
    const headers = { Accept: "text/event-stream" };
    const token = await this.token();
    if (token) headers.Authorization = `Bearer ${token}`;

    this.#fetch(this.url(this.#paths.sse), { headers, signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(response.statusText);
        this.#resetWatchdog();
        return this.#readSse(response);
      })
      .catch(() => {
        if (this.#sseAbort === controller) {
          this.#closeSse();
          this.#offLine("sse");
          this.#startPing();
        }
      });
  }

  async #readSse(response) {
    if (!response.body?.getReader) return;
    const reader = response.body.getReader();
    this.#sseReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.#sseAbort) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || "";
        for (const part of parts) await this.#handleSseMessage(part);
      }
    } finally {
      if (this.#sseReader === reader) this.#sseReader = null;
      reader.releaseLock?.();
    }
  }

  async #handleSseMessage(raw) {
    if (!raw.trim()) return;
    const receivedAt = this.#touchLastReceivedAt();
    this.#onLine("sse", undefined, { lastReceivedAt: receivedAt });
    this.#resetWatchdog();
    const lines = raw.split(/\r?\n/);
    const dataLines = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return;

    let data = dataLines.join("\n");
    try {
      data = JSON.parse(data);
    } catch (error) {
      console.error("[api] [sse]", error);
    }
    await this.#applyServiceData(data);
    this.#emitChange({ type: "sse", data, lastReceivedAt: receivedAt });
  }

  async #applyServiceData(data) {
    if (!data || typeof data !== "object") return;
    const serviceName = data.service || data.serviceName || data.tableName;
    if (!serviceName || serviceName === "audit") return;
    const service = this.#services.get(serviceName);
    if (!service) return;
    await service.applyData(data);
  }

  async #applyChangesData(data) {
    if (!Array.isArray(data)) return;
    for (const change of data) await this.#applyServiceData(change);
  }

  #resetWatchdog() {
    this.#clearWatchdog();
    this.#watchdogTimer = setTimeout(() => {
      this.#closeSse();
      this.#offLine("watchdog");
      this.#startPing();
    }, this.#sseWatchdogTimeout);
    this.#watchdogTimer.unref?.();
  }

  #clearWatchdog() {
    if (!this.#watchdogTimer) return;
    clearTimeout(this.#watchdogTimer);
    this.#watchdogTimer = null;
  }

  #closeSse() {
    const abort = this.#sseAbort;
    const reader = this.#sseReader;
    this.#sseAbort = null;
    this.#sseReader = null;
    abort?.abort();
    reader?.cancel?.().catch?.(() => {});
  }

  async #clearServices() {
    for (const [serviceName, service] of this.#services.entries()) {
      if (serviceName === "audit") continue;
      await service.clear();
      await this.#adapter.delete(this.#serviceCacheKey(serviceName));
    }
  }

  #onLine(source, data, extra = {}) {
    const changed = !this.#online;
    this.#online = true;
    this.#emitChange({ type: "online", source, data, changed, ...extra });
  }

  #offLine(source, data) {
    const changed = this.#online;
    this.#online = false;
    this.#emitChange({ type: "offline", source, data, changed });
  }

  #emitChange(event) {
    for (const listener of this.#listeners) listener(event);
  }

  #touchLastReceivedAt() {
    this.#lastReceivedAt = this.#now();
    return this.#lastReceivedAt;
  }

  #now() {
    return new Date().toISOString();
  }

  #normalizeDateTime(value) {
    return value instanceof Date ? value.toISOString() : value;
  }
}

export { ApiClient, ApiClientError, BaseAdapter, BaseService, IndexedDbAdapter, LocalStorageAdapter, MapAdapter, OpenapiService, PendingService, SchemaService, SessionService, createAdapter, createApiClient };
//# sourceMappingURL=api-client.js.map
