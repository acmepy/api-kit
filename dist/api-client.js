import yep from 'yep';
import * as idbKeyval from 'idb-keyval';

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
    throw new Error("BaseAdapter.delete debe implementarse");
  }

  async clear() {
    throw new Error("BaseAdapter.clear debe implementarse");
  }
}

class MapAdapter extends BaseAdapter {
  #map;
  #keyOf;

  constructor(map = new Map(), keyOf = (record) => record.id) {
    super();
    this.#map = map;
    this.#keyOf = keyOf;
  }

  async getAll() {
    return [...this.#map.values()];
  }

  async get(key) {
    return this.#map.get(key) ?? null;
  }

  async add(value) {
    if(Array.isArray(value)) {
      value.forEach(v => this.put(this.#keyOf(v), v));
      return value;
    }
    this.put(this.#keyOf(value), value);
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
  #keyOf;

  constructor({ storage = globalThis.localStorage, service = "", prefix = "api", keyOf = (record) => record.id } = {}) {
    super();
    if (!storage) throw new Error("LocalStorageAdapter requiere localStorage");
    this.#storage = storage;
    this.#keyOf = keyOf;
    this.#key = service ? `${prefix}:${service}` : prefix;
  }

  async getAll() {
    return JSON.parse(this.#storage.getItem(this.#key) || "[]");
  }

  async get(key) {
    return (await this.getAll()).find((item) => this.#keyOf(item) === key) || null;
  }

  async add(value) {
    if (Array.isArray(value)) {
      const records = (await this.getAll()).filter((item) => !value.some((nextItem) => this.#keyOf(nextItem) === this.#keyOf(item)));
      const nextRecords = [...records,...value];
      this.#storage.setItem(this.#key, JSON.stringify(nextRecords));
      return value;
    }
    await this.put(this.#keyOf(value), value);
    return value;
  }

  async put(key, value) {
    const records = await this.getAll();
    const nextRecords = [...records.filter((item) => this.#keyOf(item) !== key), value];
    this.#storage.setItem(this.#key, JSON.stringify(nextRecords));
    return value;
  }

  async delete(key) {
    const records = await this.getAll();
    const nextRecords = records.filter((item) => this.#keyOf(item) !== key);
    this.#storage.setItem(this.#key, JSON.stringify(nextRecords));
  }

  async clear() {
    this.#storage.removeItem(this.#key);
  }
}

// idb-keyval's UseStore API accepts a transaction callback. Manage the
// database schema here because createStore() cannot add stores to an
// existing database.
const databases = new WeakMap();

function sharedDatabaseStore(factory, dbName, storeName) {
  let byName = databases.get(factory);
  if (!byName) databases.set(factory, byName = new Map());
  let state = byName.get(dbName);
  if (!state) byName.set(dbName, state = { db: null, queue: Promise.resolve() });

  return (mode, callback) => {
    const task = state.queue.then(async () => {
      const db = await ensureStore(factory, dbName, storeName, state);
      const transaction = db.transaction(storeName, mode);
      const completed = new Promise((resolve, reject) => {
        transaction.addEventListener("complete", resolve, { once: true });
        transaction.addEventListener("abort", () => reject(transaction.error || new Error("Transaccion IndexedDB cancelada")), { once: true });
      });
      try {
        const [result] = await Promise.all([callback(transaction.objectStore(storeName)), completed]);
        return result;
      } catch (error) {
        // A callback may fail synchronously before Promise.all observes the
        // transaction promise. Always handle its rejection as well.
        completed.catch(() => {});
        try { transaction.abort(); } catch { /* Already completed. */ }
        throw error;
      }
    });
    state.queue = task.catch(() => {});
    return task;
  };
}

async function ensureStore(factory, dbName, storeName, state) {
  while (true) {
    const db = state.db || await openDatabase(factory, dbName, storeName, state);
    if (db.objectStoreNames.contains(storeName)) return db;
    const version = db.version + 1;
    db.close();
    state.db = null;
    try {
      await openDatabase(factory, dbName, storeName, state, version);
    } catch (error) {
      // Another tab may have added a store first. Reopen the current
      // version and check again rather than replacing the database.
      if (error.name !== "VersionError") throw error;
    }
  }
}

function openDatabase(factory, dbName, storeName, state, version) {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = version === undefined ? factory.open(dbName) : factory.open(dbName, version);
    request.onblocked = () => {
      blocked = true;
      reject(new Error(`La actualizacion de IndexedDB "${dbName}" esta bloqueada por otra conexion. Cierra las otras pestanas y reintenta.`));
    };
    request.onupgradeneeded = () => {
      if (blocked) {
        request.transaction.abort();
        return;
      }
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      state.db = db;
      const close = () => {
        db.close();
        if (state.db === db) state.db = null;
      };
      db.onversionchange = close;
      db.onclose = close;
      resolve(db);
    };
  });
}

class IndexedDbAdapter extends BaseAdapter {
  #keyval;
  #store;
  #keyOf;

  constructor(options = {}) {
    super();
    this.#keyOf = options.keyOf || ((record) => record.id);
    this.#keyval = options.idbKeyval || idbKeyval;
    const factory = options.indexedDB || globalThis.indexedDB;
    if (!options.idbKeyval && !factory) throw new Error("IndexedDbAdapter requiere indexedDB");
    const dbName = options.dbName || "api";
    const storeName = options.storeName || "session";
    this.#store = options.idbKeyval
      ? this.#keyval.createStore(dbName, storeName)
      : sharedDatabaseStore(factory, dbName, storeName);
  }

  async get(key) {
    return (await this.#keyval.get(key, this.#store)) ?? null;
  }

  async getAll() {
    return this.#keyval.values(this.#store);
  }

  async add(value) {
    if (Array.isArray(value)) {
      await this.#keyval.setMany(value.map((item) => [this.#keyOf(item), item]), this.#store);
      return value;
    }
    await this.put(this.#keyOf(value), value);
    return value;
  }

  async put(key, value) {
    await this.#keyval.set(key, value, this.#store);
    return value;
  }

  async delete(key) {
    await this.#keyval.del(key, this.#store);
  }

  async clear() {
    await this.#keyval.clear(this.#store);
  }
}

function createAdapter({ type, prefix = "api", service, ...options } = {}) {
  if (type === "localStorage") return new LocalStorageAdapter({ ...options, prefix, service });
  if (type === "indexedDB" || type === "indexdb") return new IndexedDbAdapter({
    ...options,
    dbName: options.dbName || prefix,
    storeName: options.storeName || service || "session",
  });
  return new MapAdapter(new Map(), options.keyOf);
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

class BaseService {
  #temporaryStorage = null;

  constructor({ client, name, path, operations = {}, schemas = {}, primaryKeyAttributes = ["id"], details = {}, tenant, prefix = "api", createAdapter }) {
    this.client = client;
    this.name = name;
    this.path = path;
    this.operations = operations;
    this.primaryKeyAttributes = primaryKeyAttributes;
    this.details = details;
    this.tenant = tenant;
    this.schemas = Object.keys(schemas).length > 0 ? schemas : null;
    this.prefix = prefix;
    this.adapter = createAdapter?.({ service: name, prefix: this.prefix, keyOf: (record) => this.keyOf(record) });
    if (client.trackServiceOperation && !["pending", "session", "schema"].includes(name)) {
      for (const method of ["save", "create", "update", "remove", "createDetail", "updateDetail", "removeDetail", "pull", "pullOne", "push", "pushOne", "applyData", "request"]) {
        const execute = this[method].bind(this);
        this[method] = (...args) => client.trackServiceOperation(this, method, () => execute(...args));
      }
    }
  }

  keyOf(record) {
    if (!record) return undefined;
    const values = this.primaryKeyAttributes.map((key) => record[key]);
    if (values.some((value) => value === undefined || value === null)) return undefined;
    return values.length === 1 ? values[0] : JSON.stringify(values);
  }

  #cacheKey(id) {
    return id && typeof id === "object" ? this.keyOf(id) : id;
  }

  #keyValues(id) {
    if (this.primaryKeyAttributes.length === 1) return { [this.primaryKeyAttributes[0]]: id };
    if (!id || typeof id !== "object" || this.keyOf(id) === undefined) {
      throw new Error("La clave compuesta requiere todos sus componentes");
    }
    return Object.fromEntries(this.primaryKeyAttributes.map((key) => [key, id[key]]));
  }

  async createDetail(id, detail, data = {}) {
    return this.#writeDetail("createDetail", id, detail, undefined, data);
  }

  async updateDetail(id, detail, detailId, data = {}) {
    return this.#writeDetail("updateDetail", id, detail, detailId, data);
  }

  async removeDetail(id, detail, detailId) {
    return this.#writeDetail("removeDetail", id, detail, detailId);
  }

  async #writeDetail(operation, id, detail, detailId, body) {
    const response = await this.#send(operation, { params: { id, detail, detailId }, body });
    const current = await this.adapter.get(this.#cacheKey(id));
    const keys = this.details[detail]?.primaryKeyAttributes;
    if (current && Array.isArray(current[detail]) && response.data && keys?.length) {
      const matches = (row) => keys.every((key) => row[key] === response.data[key]);
      const rows = current[detail].filter((row) => !matches(row));
      if (operation !== "removeDetail") rows.push(response.data);
      const next = { ...current, [detail]: rows };
      await this.adapter.put(this.#cacheKey(id), next);
    }
    this.#notify();
    return response;
  }

  async list() {
    return { ok: true, data: await this.adapter.getAll() };
  }

  async pending() {
    const result = await this.list();
    return { ...result, data: result.data.filter((record) => record?.pending) };
  }

  async get(id) {
    const data = await this.adapter.get(this.#cacheKey(id));
    return { ok: Boolean(data), data };
  }

  async save(data = {}, options = {}) {
    const key = this.keyOf(data);
    return key !== undefined && await this.adapter.get(key)
      ? this.update(this.primaryKeyAttributes.length === 1 ? key : data, data, options)
      : this.create(data, options);
  }

  async create(data = {}, options = {}) {
    this.#assertPendingTenant(data);
    const record = { ...await this.validate({ ...data, ...this.#tenantScope() }, "create"), ...this.#tenantScope() };
    const pending = options.pending ?? !this.client.connected?.();
    let networkFailed = false;
    if (!pending) {
      try {
        const response = await this.#send("create", { body: record });
        if (response.data) await this.adapter.add(response.data);
        this.#notify();
        return response;
      } catch (error) {
        if (options.pending === false || error.code !== "NETWORK_ERROR") throw error;
        networkFailed = true;
      }
    }
    data = {...record, ...this.#pendingScope(), [this.primaryKeyAttributes[0]]: record[this.primaryKeyAttributes[0]] ?? await this.nextTemporaryId(), pending: true, operation:'create', status: "pending", message: "", errors: null };
    await this.adapter.add(data);
    this.#notify();
    if (!networkFailed && this.client.connected?.()) this.#throwPushError(await this.pushOne(data));
    return { ok: true, data };
  }

  async update(id, data = {}, options = {}) {
    const current = await this.adapter.get(this.#cacheKey(id));
    this.#assertPendingTenant(current);
    const creating = current?.pending && current.operation === "create";
    const record = await this.validate({...current, ...data, ...this.#keyValues(id)}, creating ? "create" : "update");
    const pending = options.pending ?? !this.client.connected?.();
    let networkFailed = false;
    if(!pending && !creating) {
      try {
        const response = await this.#send("update", { params: { id }, body: data });
        const nextRecord = response.data || record;
        await this.adapter.put(this.keyOf(nextRecord) ?? this.#cacheKey(id), nextRecord);
        this.#notify();
        return response;
      } catch (error) {
        if (options.pending === false || error.code !== "NETWORK_ERROR") throw error;
        networkFailed = true;
      }
    }
    data = {...record, ...this.#pendingScope(current), ...this.#keyValues(id), pending: true, operation: creating ? "create" : "update", status: "pending", message: "", errors: null };
    await this.adapter.put(this.keyOf(data) ?? this.#cacheKey(id), data);
    this.#notify();
    if (!networkFailed && this.client.connected?.()) this.#throwPushError(await this.pushOne(data));
    return { ok: true, data };
  }

  async remove(id, options = {}) {
    const current = await this.adapter.get(this.#cacheKey(id));
    this.#assertPendingTenant(current);
    if (current?.pending && current.operation === "create") {
      await this.adapter.delete(this.#cacheKey(id));
      this.#notify();
      return { ok: true, data: current };
    }
    const pending = options.pending ?? !this.client.connected?.();
    let networkFailed = false;
    if (!pending) {
      try {
        const response = await this.#send("remove", { params: { id } });
        await this.adapter.delete(this.#cacheKey(id));
        this.#notify();
        return response;
      } catch (error) {
        if (options.pending === false || error.code !== "NETWORK_ERROR") throw error;
        networkFailed = true;
      }
    }
    const data = {...current, ...this.#pendingScope(current), ...this.#keyValues(id), pending: true, operation:'remove', status: "pending", message: "", errors: null };
    await this.adapter.put(this.keyOf(data), data);
    this.#notify();
    if (!networkFailed && this.client.connected?.()) this.#throwPushError(await this.pushOne(data));
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
    if (response.data && this.keyOf(response.data) !== undefined) {
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
      const current = await this.#recordForChange(data, this.keyOf(changes));
      const id = this.keyOf(current) ?? this.keyOf(changes) ?? data.rowId ?? data.id ?? this.keyOf(data.old);
      if (id === undefined || id === null) return;
      const record = isUpdate ? { ...current, ...changes } : { ...changes };
      if (this.primaryKeyAttributes.length === 1) record[this.primaryKeyAttributes[0]] ??= id;
      await this.adapter.put(id, record);
      this.#notify();
      return;
    }
    if (action === "delete" || action === "bulk-delete" || action === "remove" || action === "bulk-remove") {
      const current = await this.#recordForChange(data);
      const id = this.keyOf(current) ?? this.keyOf(data.old) ?? data.rowId ?? data.id;
      if (id === undefined || id === null) return;
      await this.adapter.delete(this.#cacheKey(id));
      this.#notify();
      return;
    }
  }

  async nextTemporaryId() {
    if (!this.#temporaryStorage) this.#temporaryStorage = defaultAdapter({ prefix: this.prefix, service: "temporaryKey" });
    const record = await this.#temporaryStorage.get("temporaryKey");
    const value = Number(record?.value || 0) + 1;
    await this.#temporaryStorage.put("temporaryKey", { id: "temporaryKey", value });
    return value;
  }

  async push(id = null) {
    const targets = id === null ? (await this.pending()).data : [await this.adapter.get(this.#cacheKey(id))].filter(Boolean);
    const results = [];
    for (const record of targets) results.push(await this.pushOne(record));
    const errors = results.filter((result) => !result.ok);
    return { ok: errors.length === 0, results, errors };
  }

  async pushOne(record) {
    try {
      const response = await this.#sendPendingOperation(record);
      if (record.operation === "remove") {
        await this.adapter.delete(this.keyOf(record));
      } else {
        const nextRecord = { ...this.#pendingBody(record), ...response.data };
        await this.adapter.put(this.keyOf(nextRecord), nextRecord);
        if (this.keyOf(nextRecord) !== this.keyOf(record)) await this.adapter.delete(this.keyOf(record));
      }
      this.#notify();
      return { ok: true, id: this.keyOf(record), operation: record.operation, response };
    } catch (error) {
      const errors = error.errors || error.response?.errors || null;
      const nextRecord = {...record, pending: true, status: "error", message: error.message, errors};
      await this.adapter.put(this.keyOf(record), nextRecord);
      this.#notify();
      return { ok: false, id: this.keyOf(record), operation: record.operation, error: error.message, errors };
    }
  }

  async validate(data = {}, operation = "create") {
    const schema = await this.#yepSchema(operation);
    if (!schema) return data;
    const validated = await schema.validate(data);
    for (const name of Object.keys(this.details)) {
      if (Object.hasOwn(data, name)) validated[name] = data[name];
    }
    return validated;
  }

  async validateAt(attribute, data = {}, operation = "create") {
    const schema = await this.#yepSchema(operation);
    if (!schema) return data?.[attribute];
    return schema.validateAt(attribute, data);
  }

  async unique(field, value, data = {}) {
    if (value === undefined || value === null) return null;
    const currentId = this.keyOf(data);
    const records = (await this.list()).data;
    const duplicate = records.find((record) => (
      record?.[field] === value && (currentId === undefined || String(this.keyOf(record)) !== String(currentId))
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
    const attribute = (params.detail ? this.details[params.detail]?.tenant : this.tenant)?.attribute;
    const tenantId = this.client.tenantId?.();
    if (attribute && tenantId !== undefined) query = { ...query, [attribute]: tenantId };
    if (params.id && typeof params.id === "object") {
      const key = this.#keyValues(params.id);
      query = { ...query, ...key };
      params = { ...params, id: key[this.primaryKeyAttributes[0]] };
    }
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
    const id = preferredId ?? data.rowId ?? data.id ?? this.keyOf(data.old);
    if (id === undefined || id === null) return null;
    const direct = await this.adapter.get(this.#cacheKey(id));
    if (direct) return direct;
    return (await this.adapter.getAll()).find((record) => String(this.keyOf(record)) === String(id)) || null;
  }

  async #sendPendingOperation(record) {
    this.#assertPendingTenant(record);
    if (record.operation === "create") return this.#send("create", { body: this.#pendingBody(record) });
    if (record.operation === "update") return this.#send("update", { params: { id: this.primaryKeyAttributes.length === 1 ? this.keyOf(record) : record }, body: this.#pendingBody(record) });
    if (record.operation === "remove") return this.#send("remove", { params: { id: this.primaryKeyAttributes.length === 1 ? this.keyOf(record) : record } });
    throw new Error(`Operacion pendiente "${record.operation}" no soportada`);
  }
  #pendingBody(record) {
    const { pending, operation, status, message, errors, pendingTenantId, ...body } = record;
    return body;
  }

  #pendingScope(record) {
    const tenantId = record?.pendingTenantId ?? this.client.tenantId?.();
    return tenantId === undefined ? {} : { ...this.#tenantScope(), pendingTenantId: tenantId };
  }

  #tenantScope() {
    const tenantId = this.client.tenantId?.();
    return this.tenant?.attribute && tenantId !== undefined ? { [this.tenant.attribute]: tenantId } : {};
  }

  #assertPendingTenant(record) {
    const tenantId = record?.pendingTenantId ?? (this.tenant?.attribute ? record?.[this.tenant.attribute] : undefined);
    if (tenantId !== undefined && tenantId !== this.client.tenantId?.()) {
      throw new ApiClientError("El registro pertenece a otro tenant", { status: 409, response: { ok: false, code: "TENANT_MISMATCH" } });
    }
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

function encodeBody(body, headers) {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (typeof FormData !== "undefined" && body instanceof FormData) return body;
  headers["Content-Type"] = headers["Content-Type"] || "application/json";
  return JSON.stringify(body);
}

const INTERNAL_SERVICES = new Set(["audit", "auth", "postman", "session", "schema", "pending", "system", "install"]);

function discoverServiceDescriptors(document, baseUrl = "") {
  if (!Array.isArray(document?.services)) return [];
  return document.services
    .filter((service) => !INTERNAL_SERVICES.has(service.name))
    .map((service) => schemaServiceDescriptor(service, baseUrl));
}

function schemaServiceDescriptor(service, baseUrl) {
  const pathPrefix = String(baseUrl || "").replace(/\/+$/g, "");
  const operations = Object.fromEntries(Object.entries(service.operations || {}).map(([name, operation]) => [name, {
    ...operation,
    path: stripPathPrefix(operation.path, pathPrefix),
  }]));
  return { ...service, path: operations.list?.path || Object.values(operations)[0]?.path || "", operations };
}

function stripPathPrefix(path, prefix) {
  return prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
}

class PendingService extends BaseService {
  #pushPromise = null;

  constructor({ client, prefix }) {
    super({ client, name: "pending", path: "", operations: {}, schemas: {}, prefix });
  }

  async list() {
    const pending = [];
    for (const service of this.client.services().values()) {
      if (service === this || ["session", "schema"].includes(service.name) || typeof service.pending !== "function") continue;
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

  push() {
    if (this.#pushPromise) return this.#pushPromise;
    const task = this.#pushAll().finally(() => {
      if (this.#pushPromise === task) this.#pushPromise = null;
    });
    this.#pushPromise = task;
    return task;
  }

  async #pushAll() {
    const results = [];
    for (const service of this.client.services().values()) {
      if (service === this || ["session", "schema"].includes(service.name) || typeof service.push !== "function") continue;
      try {
        const response = await service.push();
        results.push(...response.results.map((result) => ({ ...result, service: service.name })));
      } catch (error) {
        results.push({ ok: false, service: service.name, error: error.message, errors: error.errors || null });
      }
    }
    const errors = results.filter((result) => !result.ok);
    return { ok: errors.length === 0, results, errors };
  }

  async nextTemporaryId() {
    throw new Error("PendingService.nextTemporaryId no implementado");
  }

  async clear() {
    return null;
  }
}

class SchemaService extends BaseService {
  constructor({ client, prefix, createAdapter, path = "/schema.json" }) {
    super({ client, name: "schema", path, operations: {}, schemas: {}, prefix, createAdapter });
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
    const document = await this.client.request(this.path, { method: "GET", cache: "no-store" });
    await this.adapter.clear();
    await this.adapter.put("document", document);
    return document;
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
    return this.client.refreshSession();
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
const DEFAULT_SERVICE_SYNC_DELAY = 1000;

function normalizeCacheTimeout(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout >= 0 ? timeout : fallback;
}

function normalizeServiceSyncDelay(value) {
  if (value === false) return false;
  if (value === undefined || value === null) return DEFAULT_SERVICE_SYNC_DELAY;
  const delay = Number(value);
  return Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_SERVICE_SYNC_DELAY;
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
  #sessionVersion = 0;
  #expireSessionPromise = null;
  #authExpired = false;
  #sessionSyncEnabled = true;
  #services = new Map();
  #listeners = new Set();
  #online = false;
  #lastReceivedAt = null;
  #syncServicesPromise = null;
  #backgroundSyncPromise = null;
  #backgroundServiceSyncs = new Map();
  #scheduledServiceSyncs = new Map();
  #cachedRequests = new Map();
  #changesPromise = null;
  #changesAbort = null;
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
  #serviceSyncDelay;
  #changesEnabled;
  #sseEnabled;
  #logging;
  #paths;
  #tenantChangePromise = null;
  #tenantChanging = false;
  #tenantReloading = false;
  #tenantConflict = false;
  #tenantVerified = false;
  #tenantVerification = null;
  #activeOperations = new Set();
  #requests = new Set();
  #tenantChannel = null;

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
    this.#serviceSyncDelay = normalizeServiceSyncDelay(options.serviceSyncDelay);
    this.#changesEnabled = options.changes !== false;
    this.#sseEnabled = options.sse !== false;
    this.#logging = options.logging || false;
    this.#paths = {
      login: options.loginPath || "/login",
      logout: options.logoutPath || "/logout",
      session: options.sessionPath || "/session",
      ping: options.pingPath || "/ping",
      schema: options.schemaPath || "/schema.json",
      changes: options.changesPath || "/changes",
      sse: options.ssePath || "/sse",
    };

    if (!this.#fetch) throw new Error("ApiClient requiere fetch");
    this.#tenantChannel = options.tenantChannel || (typeof window !== "undefined" && typeof BroadcastChannel === "function"
      ? new BroadcastChannel(`api-tenant:${this.#host}${this.#baseUrl}:${this.#prefix}`) : null);
    if (this.#tenantChannel) this.#tenantChannel.onmessage = ({ data }) => {
      if (data?.sessionId != null && data.sessionId === this.#session?.id && !this.#tenantChanging) this.#adoptExternalTenant();
    };
    queueMicrotask(() => this.#startPing());
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  get adapter() {
    return this.#adapter;
  }

  async login(credentials = {}, { sync = true } = {}) {
    const response = await this.request(this.#paths.login, { method: "POST", body: credentials, auth: false });
    if (this.#expireSessionPromise) await this.#expireSessionPromise;
    const previousSession = (await this.sessionService().adapter.getAll())[0];
    if (previousSession?.authExpired && previousSession.user?.id != null && previousSession.user.id !== response.data?.user?.id) {
      throw new ApiClientError("Debe reconectar con el mismo usuario para conservar los datos locales", {
        status: 409,
        response: { ok: false, code: "SESSION_USER_MISMATCH" },
      });
    }
    if ((previousSession?.tenantId !== undefined || response.data?.tenantId !== undefined)
        && (previousSession?.tenantId !== response.data?.tenantId || previousSession?.user?.id !== response.data?.user?.id)) {
      return this.#startTenantChange(response.data?.tenantId, { supplied: response, sync });
    }
    this.#sessionSyncEnabled = sync;
    this.#authExpired = false;
    this.#stopPing();
    this.#closeSse();
    this.#clearWatchdog();
    this.#clearScheduledServiceSyncs();
    await this.sessionService().create(response.data || null);
    this.#session = response.data || null;
    this.#tenantVerified = response.data?.tenantId !== undefined;
    this.#sessionVersion++;
    this.#onLine("login", response.data);

    if (!sync) return response;
    await this.syncServices();
    if (this.#changesEnabled) await this.changes();
    this.#stopPing();
    if (this.#sseEnabled) await this.#openSse();
    return response;
  }

  async logout() {
    let response;
    try {
      response = await this.request(this.#paths.logout, { method: "POST" });
    } catch (error) {
      if (error.status !== 401) throw error;
      await this.#resetSession("logout", null);
      return { ok: true, data: null };
    }
    await this.#resetSession("logout", response.data);
    return response;
  }

  tenantChanging() { return this.#tenantChanging; }
  tenantId() { return this.#session?.tenantId; }

  async refreshSession() {
    if (this.#tenantChanging) throw this.#tenantError("Cambio de tenant en curso", "TENANT_CHANGE_IN_PROGRESS");
    const previous = this.#session || (await this.sessionService().adapter.getAll())[0];
    const response = await this.request(this.#paths.session, { token: previous?.token, requireToken: true, tenantChange: true });
    if ((previous?.tenantId !== undefined || response.data?.tenantId !== undefined)
        && (previous?.tenantId !== response.data?.tenantId || previous?.user?.id !== response.data?.user?.id)) {
      return this.#startTenantChange(response.data?.tenantId, { supplied: response, external: true });
    }
    this.#session = { ...previous, ...response.data };
    await this.sessionService().create(this.#session);
    this.#tenantVerified = response.data?.tenantId !== undefined;
    this.#emitChange({ type: "session", source: "session-updated" });
    return response;
  }

  getTenants() { return this.request("/me/tenants"); }

  async updateUserOptions(options) {
    return this.#updateUser("/me/options", { options });
  }

  async setUserTenant(tenantId) {
    return this.#updateUser("/me/tenant", { tenantId });
  }

  async #updateUser(path, body) {
    const response = await this.request(path, { method: "PATCH", body });
    const session = (await this.sessionService().adapter.getAll())[0];
    await this.sessionService().create({ ...session, user: response.data });
    this.#session = { ...session, user: response.data };
    this.#emitChange({ type: "session", source: "session-updated" });
    return response;
  }

  async updateSessionOptions(options) {
    const response = await this.request("/session/options", { method: "PATCH", body: { options } });
    const session = (await this.sessionService().adapter.getAll())[0];
    this.#session = { ...session, ...response.data };
    await this.sessionService().create(this.#session);
    this.#emitChange({ type: "session", source: "session-updated" });
    return response;
  }

  setSessionTenant(tenantId) { return this.#startTenantChange(tenantId); }

  #startTenantChange(tenantId, options = {}) {
    if (this.#tenantChangePromise) return Promise.reject(this.#tenantError("Cambio de tenant en curso", "TENANT_CHANGE_IN_PROGRESS"));
    let failed = false;
    const task = this.#changeTenant(tenantId, options).catch(error => { failed = true; throw error; }).finally(() => {
      this.#tenantChangePromise = null;
      this.#tenantChanging = false;
      this.#tenantReloading = false;
      this.#emitChange({ type: "session", source: "tenant-change-finished" });
      if (failed && !this.#tenantConflict && this.#sessionSyncEnabled) this.#startPing();
    });
    this.#tenantChangePromise = task;
    return task;
  }

  async #changeTenant(tenantId, { supplied, external = false, sync = true } = {}) {
    this.#tenantChanging = true;
    const previous = this.#session || (await this.sessionService().adapter.getAll())[0];
    const wasSyncEnabled = this.#sessionSyncEnabled;
    let changed = false;
    let committed = false;
    let mutationSent = false;
    try {
      this.#sessionSyncEnabled = false;
      this.#sessionVersion++;
      this.#stopPing(); this.#closeSse(); this.#clearWatchdog(); this.#clearScheduledServiceSyncs();
      this.#changesAbort?.abort();
      for (const controller of this.#requests) controller.abort();
      this.#emitChange({ type: "session", source: "tenant-changing" });
      await Promise.allSettled([...this.#activeOperations, ...this.#backgroundServiceSyncs.values(), ...this.#cachedRequests.values(),
        this.#syncServicesPromise, this.#backgroundSyncPromise, this.#changesPromise].filter(Boolean));
      const cachedSchema = await this.#cachedDocument(this.#services.get("schema") || new SchemaService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter }));
      const services = new Map(this.#services);
      for (const descriptor of discoverServiceDescriptors(cachedSchema || {}, this.#baseUrl)) {
        if (!services.has(descriptor.name)) services.set(descriptor.name, new BaseService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter, ...descriptor }));
      }
      const hasPending = async () => {
        for (const [name, service] of services) if (!["schema", "session", "pending"].includes(name) && (await service.pending()).data.length) return true;
        return false;
      };
      if (!external && (tenantId !== previous?.tenantId || supplied && supplied.data?.user?.id !== previous?.user?.id) && await hasPending()) {
        throw this.#tenantError("Envie o elimine los pendientes antes de cambiar de tenant", "TENANT_PENDING_OPERATIONS");
      }
      const stored = (await this.sessionService().adapter.getAll())[0];
      mutationSent = !external && !supplied;
      const response = supplied || await this.request(external ? this.#paths.session : "/session/tenant", {
        method: external ? "GET" : "PATCH", body: external ? undefined : { tenantId },
        token: external ? stored?.token || previous?.token : previous?.token, tenantChange: true, requireToken: true,
      });
      const session = { ...previous, ...response.data, token: response.data?.token || stored?.token || previous?.token, authExpired: false };
      changed = session.tenantId !== previous?.tenantId || session.user?.id !== previous?.user?.id;
      if (external && changed && await hasPending()) {
        this.#tenantConflict = true;
        throw this.#tenantError("El tenant cambio en otra conexion y hay pendientes locales; restaure el tenant anterior para enviarlos", "TENANT_CHANGED_WITH_PENDING");
      }
      if (changed) {
        for (const service of services.values()) await service.clear();
        await this.#adapter.clear();
        this.#services.clear();
        this.#services.set("pending", new PendingService({ client: this, prefix: this.#prefix }));
        this.#lastReceivedAt = null;
      }
      this.#session = session;
      await this.sessionService().create(session);
      committed = true;
      this.#tenantConflict = false;
      this.#tenantVerified = true;
      this.#authExpired = false;
      this.#sessionSyncEnabled = sync;
      this.#tenantReloading = true;
      this.#onLine("tenant-changed", session);
      if (!external) this.#tenantChannel?.postMessage({ sessionId: previous?.id });
      if (sync) {
        const since = this.#now();
        await this.syncServices(changed);
        if (changed) {
          this.#clearScheduledServiceSyncs();
          const pulls = await Promise.allSettled([...this.#services].filter(([name]) => !["schema", "session", "pending"].includes(name)).map(([, service]) => service.pull()));
          const failure = pulls.find(result => result.status === "rejected");
          if (failure) throw failure.reason;
        }
        if (this.#changesEnabled) await this.changes(since);
        if (this.#sseEnabled) await this.#openSse();
      }
      return response;
    } catch (error) {
      if (!changed) this.#sessionSyncEnabled = wasSyncEnabled;
      if (changed && !committed || mutationSent && error.code === "NETWORK_ERROR") this.#tenantConflict = true;
      if (this.#tenantConflict) this.#sessionSyncEnabled = false;
      this.#emitChange({ type: "session", source: "tenant-change-failed", error });
      throw error;
    }
  }

  #tenantError(message, code) { return new ApiClientError(message, { status: 409, response: { ok: false, code } }); }

  async #verifyTenantSession() {
    if (this.#tenantVerified || this.#session?.tenantId === undefined) return;
    if (this.#tenantVerification) return this.#tenantVerification;
    const verification = (async () => {
      const response = await this.request(this.#paths.session, { token: this.#session.token, tenantChange: true, requireToken: true });
      if (response.data?.tenantId !== this.#session.tenantId || response.data?.user?.id !== this.#session.user?.id) {
        this.#adoptExternalTenant();
        throw this.#tenantError("El tenant cambio en el servidor; espere la recarga", "TENANT_CHANGED");
      }
      this.#tenantVerified = true;
    })();
    this.#tenantVerification = verification;
    try { await verification; }
    finally { if (this.#tenantVerification === verification) this.#tenantVerification = null; }
  }

  #adoptExternalTenant() {
    if (this.#tenantChanging) return;
    this.#startTenantChange(undefined, { external: true }).catch(error => this.#emitChange({ type: "error", source: "tenant-change-failed", error }));
  }

  async #checkStoredTenant() {
    if (this.#tenantChanging) return;
    const stored = (await this.sessionService().adapter.getAll())[0];
    if (!this.#session) { this.#session = stored || null; return; }
    if (stored && (stored.tenantId !== this.#session.tenantId || stored.user?.id !== this.#session.user?.id)) {
      this.#adoptExternalTenant();
      throw this.#tenantError("El tenant de la sesion cambio; espere la recarga", "TENANT_CHANGED");
    }
  }

  trackServiceOperation(service, method, execute) {
    if (this.#session?.tenantId === undefined && !this.#tenantChanging && !this.#tenantConflict) return execute();
    return this.#trackTenantOperation(service, method, execute);
  }

  async #trackTenantOperation(service, method, execute) {
    await this.#checkStoredTenant();
    if (this.#tenantConflict) throw this.#tenantError("Restaure el tenant de los pendientes locales", "TENANT_CHANGED_WITH_PENDING");
    if (this.#tenantChanging && !(this.#tenantReloading && ["pull", "pullOne", "applyData"].includes(method))) {
      throw this.#tenantError("Cambio de tenant en curso", "TENANT_CHANGE_IN_PROGRESS");
    }
    if (this.#services.get(service.name) !== service) throw this.#tenantError("El servicio fue reemplazado; obtengalo nuevamente", "SERVICE_REPLACED");
    const task = Promise.resolve().then(execute);
    this.#activeOperations.add(task);
    const done = () => this.#activeOperations.delete(task);
    task.then(done, done);
    return task;
  }

  async #resetSession(source, data) {
    this.#tenantVerified = false;
    if (source !== "auth-expired") { this.#session = null; this.#tenantConflict = false; }
    this.#sessionVersion++;
    this.#stopPing();
    this.#closeSse();
    this.#clearWatchdog();
    this.#changesAbort?.abort();
    this.#changesAbort = null;
    this.#changesPromise = null;
    this.#clearScheduledServiceSyncs();
    if (source === "auth-expired") {
      this.#authExpired = true;
      this.#sessionSyncEnabled = false;
      const previousSession = (await this.sessionService().adapter.getAll())[0] || { id: "session" };
      await this.sessionService().create({ ...previousSession, token: null, authExpired: true });
    } else {
      await this.#clearServices();
      await this.#adapter.clear();
      this.#services.clear();
      this.#services.set("pending", new PendingService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter }));
      this.#lastReceivedAt = null;
      this.#authExpired = false;
      this.#sessionSyncEnabled = true;
    }
    this.#offLine(source, data);
    this.#startPing();
  }

  sessionService(){
    if (!this.#services.has("session")) this.#services.set('session', new SessionService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter, path: this.#paths.session }));    
    return this.service("session")
  }
  async session() {
    const session = (await this.sessionService().adapter.getAll())[0] || {};
    if (session.authExpired) {
      this.#authExpired = true;
      this.#sessionSyncEnabled = false;
      return {};
    }
    if (!this.#session?.token) this.#session = session;
    if (session?.token && this.#sessionSyncEnabled && !this.#tenantChanging && !this.#syncServicesPromise) await this.syncServices();
    return session;
  }

  async #expireSession(error, sessionVersion) {
    if (this.#expireSessionPromise) return this.#expireSessionPromise;
    if (sessionVersion !== this.#sessionVersion) return;

    const expiration = this.#resetSession("auth-expired", error?.response || null);
    this.#expireSessionPromise = expiration;
    try {
      await expiration;
    } finally {
      if (this.#expireSessionPromise === expiration) this.#expireSessionPromise = null;
    }
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
    if (this.#authExpired) throw new ApiClientError("Sesion expirada; vuelva a iniciar sesion", { status: 401 });
    this.#sessionSyncEnabled = true;
    if (this.#syncServicesPromise) {
      this.#log("schema", "reutilizando sincronizacion en curso");
      return this.#syncServicesPromise;
    }
    if (!force && this.#services.get("schema")) {
      this.#log("schema", "servicios ya registrados");
      return;
    }

    const sync = this.#synchronizeServices(force);
    this.#syncServicesPromise = sync;
    try {
      return await sync;
    } finally {
      if (this.#syncServicesPromise === sync) this.#syncServicesPromise = null;
    }
  }

  async #synchronizeServices(force) {
    const schemaService = new SchemaService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter, path: this.#paths.schema });
    this.#services.set("schema", schemaService);
    const cachedSchema = await this.#cachedDocument(schemaService);
    const cacheMetadata = await schemaService.adapter.get("metadata");

    if (!force && cachedSchema && this.#isSyncCacheFresh(cacheMetadata)) {
      this.#log("schema", "usando manifiesto local vigente");
      await this.#registerSchemaServices(cachedSchema, schemaService);
      return;
    }

    if (!force && cachedSchema && cacheMetadata) {
      this.#log("schema", "usando manifiesto local vencido y actualizando en segundo plano");
      await this.#registerSchemaServices(cachedSchema, schemaService);
      if (this.#online) this.#refreshSchemaDocumentInBackground(schemaService);
      return;
    }

    await this.#refreshSchemaDocument(schemaService, force, cachedSchema);
  }

  async #refreshSchemaDocument(schemaService, force, fallbackSchema = null) {
    let schema = fallbackSchema;
    try {
      if (!this.#online) throw Error("OffLine");
      this.#log("schema", "descargando", { path: this.#paths.schema, force });
      const document = await schemaService.pull();
      if (!Array.isArray(document?.services)) throw new Error("Documento schema invalido");
      schema = document;
      this.#log("schema", "descargado", { services: document.services.length });
    } catch (error) {
      if (error.status === 401) {
        throw error;
      }
      schema ||= await this.#cachedDocument(schemaService);
      if (!schema) {
        if (error.message === "OffLine") {
          this.#log("schema", "sin conexion ni manifiesto local");
          return;
        }
        throw error;
      }
      this.#log("schema", "fallo la descarga; usando manifiesto local", { message: error.message, status: error.status });
    }

    await this.#registerSchemaServices(schema, schemaService, { force });
    if (schema && schema !== fallbackSchema) {
      await schemaService.adapter.put("metadata", { id: "metadata", lastUpdateAt: new Date().toISOString() });
      this.#log("schema", "cache actualizado");
    }
  }

  #refreshSchemaDocumentInBackground(schemaService) {
    if (this.#backgroundSyncPromise) return;
    this.#log("schema", "iniciando actualizacion en segundo plano");
    const refresh = this.#refreshSchemaDocument(schemaService, false)
      .catch((error) => {
        if (error?.status !== 401) console.error("api-client, syncServices", error);
      })
      .finally(() => {
        if (this.#backgroundSyncPromise === refresh) this.#backgroundSyncPromise = null;
      });
    this.#backgroundSyncPromise = refresh;
  }

  async #registerSchemaServices(schema, schemaService, { force = false } = {}) {
    this.#log("schema", "registrando servicios", { services: schema.services?.length || 0 });
    for (const descriptor of discoverServiceDescriptors(schema, this.#baseUrl)) {
      if (!descriptor.operations.list) continue;
      const service = new BaseService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter, ...descriptor });
      if (this.#session?.tenantId !== undefined) {
        const scopeId = `tenant:${descriptor.name}`;
        const scope = await this.#adapter.get(scopeId);
        if (scope?.tenantId !== this.#session.tenantId || scope?.userId !== this.#session.user?.id) {
          if ((await service.pending()).data.length) {
            this.#services.set(descriptor.name, service);
            this.#tenantConflict = true;
            throw this.#tenantError("Hay pendientes cuyo tenant local no coincide con la sesion", "TENANT_CHANGED_WITH_PENDING");
          }
          await service.clear();
        }
        await this.#adapter.put(scopeId, { id: scopeId, tenantId: this.#session.tenantId, userId: this.#session.user?.id });
      }
      this.#services.set(descriptor.name, service);
      if (Object.keys(descriptor.schemas || {}).length > 0) await schemaService.update(descriptor.name, descriptor.schemas);
      try {
        const localRecords = (await service.list()).data;
        const cacheFresh = await this.#isServiceCacheFresh(descriptor.name);
        if (force || localRecords.length === 0 || !cacheFresh) {
          this.#scheduleServiceRefresh(service, { force, reason: localRecords.length === 0 ? "sin datos locales" : "cache vencido" });
        }
      } catch (error) {
        if (error?.status === 401) {
          throw error;
        }
        console.error("api-client, syncServices", error);
      }
    }
  }

  #refreshServiceInBackground(service) {
    if (!this.#online || !this.#sessionSyncEnabled || this.#authExpired) return;
    if (this.#backgroundServiceSyncs.has(service.name)) return;
    this.#log("service", "actualizando en segundo plano", { service: service.name });
    const refresh = service.pull()
      .catch((error) => {
        if (error?.status !== 401) console.error("api-client, service refresh", service.name, error);
      })
      .finally(() => this.#backgroundServiceSyncs.delete(service.name));
    this.#backgroundServiceSyncs.set(service.name, refresh);
  }

  #scheduleServiceRefresh(service, { force = false, reason } = {}) {
    if (!this.#online || !this.#sessionSyncEnabled || this.#authExpired) return;
    if (this.#serviceSyncDelay === false) {
      this.#log("service", "precarga desactivada", { service: service.name, reason });
      return;
    }
    if (this.#backgroundServiceSyncs.has(service.name) || this.#scheduledServiceSyncs.has(service.name)) return;

    const delay = force ? 0 : this.#serviceSyncDelay;
    this.#log("service", "precarga programada", { service: service.name, delay, reason });
    const timer = setTimeout(async () => {
      this.#scheduledServiceSyncs.delete(service.name);
      const localRecords = (await service.list()).data;
      if (!force && localRecords.length > 0 && await this.#isServiceCacheFresh(service.name)) {
        this.#log("service", "precarga omitida; cache actualizada", { service: service.name });
        return;
      }
      this.#refreshServiceInBackground(service);
    }, delay);
    timer.unref?.();
    this.#scheduledServiceSyncs.set(service.name, timer);
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

  async #cachedDocument(service) {
    const document = await service.adapter.get("document");
    if (document) return document;
    return (await service.adapter.getAll()).find((record) => record?.schema) || null;
  }

  #isSyncCacheFresh(metadata) {
    const updatedAt = Date.parse(metadata?.lastUpdateAt || "");
    return Number.isFinite(updatedAt) && Date.now() - updatedAt < this.#syncCacheTimeout;
  }

  connected() {
    return this.#online;
  }

  lastReceivedAt() {
    return this.#lastReceivedAt;
  }

  destroy() {
    this.#tenantChannel?.close();
    for (const controller of this.#requests) controller.abort();
    this.#stopPing();
    this.#clearScheduledServiceSyncs();
    this.#closeSse();
    this.#clearWatchdog();
    this.#listeners.clear();
  }

  /** Stops background synchronization and releases client listeners; alias of destroy(). */
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
    const controller = new AbortController();
    this.#changesAbort = controller;
    const requestedSince = since ? this.#normalizeDateTime(since) : this.#lastReceivedAt || this.#now();
    const query = { since: requestedSince };
    let response;
    try {
      response = await this.request(this.#paths.changes, { query, signal: controller.signal });
      controller.signal.throwIfAborted();
    } finally {
      if (this.#changesAbort === controller) this.#changesAbort = null;
    }
    const receivedAt = this.#touchLastReceivedAt();
    await this.#applyChangesData(response.data);
    this.#onLine("changes", response.data, { lastReceivedAt: receivedAt });
    this.#emitChange({ type: "changes", data: response.data, lastReceivedAt: receivedAt });
    return response;
  }

  async request(path, options = {}) {
    if (!options.tenantChange) {
      if (this.#tenantConflict) throw this.#tenantError("El tenant cambio y hay pendientes locales", "TENANT_CHANGED_WITH_PENDING");
      if (this.#tenantChanging && !this.#tenantReloading) throw this.#tenantError("Cambio de tenant en curso", "TENANT_CHANGE_IN_PROGRESS");
      if (this.#session?.tenantId !== undefined) await this.#checkStoredTenant();
    }
    const controller = new AbortController();
    this.#requests.add(controller);
    try {
      return await this.#request(path, { ...options, sessionVersion: this.#sessionVersion,
        signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
    } finally { this.#requests.delete(controller); }
  }

  async #request(path, options = {}) {
    const url = this.url(path, options.query);
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    const body = encodeBody(options.body, headers);
    const token = options.auth === false ? null : options.token || await this.token() || null;
    if (options.auth !== false && token && !options.tenantChange) await this.#verifyTenantSession();
    if (options.auth !== false && this.#authExpired) throw new ApiClientError("Sesion expirada; vuelva a iniciar sesion", { status: 401 });
    const sessionVersion = options.sessionVersion;
    if (sessionVersion !== this.#sessionVersion) throw new DOMException("Sesion cambiada", "AbortError");
    if (options.requireToken && !token) throw new ApiClientError("Sesion local requerida", { status: 401 });
    if (options.auth !== false && token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await this.#fetch(url, { method: options.method || "GET", headers, body, signal: options.signal, cache: options.cache });
    } catch (error) {
      if (options.signal?.aborted || error.name === "AbortError") throw error;
      const payload = { ok: false, code: "NETWORK_ERROR", message: error.message || "Error de red", error };
      if (sessionVersion === this.#sessionVersion) {
        this.#closeSse();
        this.#clearWatchdog();
        this.#offLine("request", payload);
        this.#startPing();
      }
      throw new ApiClientError(payload.message, { response: payload });
    }
    const contentType = response.headers?.get?.("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok || payload?.ok === false){
      const error = new ApiClientError(payload?.message || response.statusText, { status: response.status, response: payload });
      if (error.status === 401 && options.auth !== false) await this.#expireSession(error, sessionVersion);
      if (error.code === "TENANT_MISMATCH" && !options.tenantChange && !this.#tenantChanging) {
        this.#tenantVerified = false;
        this.#adoptExternalTenant();
      }
      throw error;
    }

    if (options.auth !== false && sessionVersion !== this.#sessionVersion) throw new DOMException("Sesion cambiada", "AbortError");
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
      if (!this.#sessionSyncEnabled) return;
      const localSession = await this.session() || null;
      if (!localSession?.token) throw new ApiClientError("Sesion local requerida", { status: 401 });
      await this.#verifyTenantSession();
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
    const localSession = (await this.sessionService().adapter.getAll())[0];
    if (localSession?.authExpired) {
      this.#authExpired = true;
      this.#sessionSyncEnabled = false;
    }
    if (!this.#authExpired) this.#onLine("ping", response.data);
    return response;
  }

  #startPing() {
    if (this.#tenantChanging || this.#tenantConflict) return;
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
    const sessionVersion = this.#sessionVersion;

    this.#fetch(this.url(this.#paths.sse), { headers, signal: controller.signal })
      .then(async (response) => {
        controller.signal.throwIfAborted();
        if (response.status === 401) {
          const error = new ApiClientError(response.statusText, { status: response.status });
          await this.#expireSession(error, sessionVersion);
          throw error;
        }
        if (!response.ok) throw new Error(response.statusText);
        this.#resetWatchdog();
        return this.#readSse(response, sessionVersion);
      })
      .catch(() => {
        if (this.#sseAbort === controller) {
          this.#closeSse();
          this.#offLine("sse");
          this.#startPing();
        }
      });
  }

  async #readSse(response, sessionVersion) {
    if (!response.body?.getReader) return;
    const reader = response.body.getReader();
    this.#sseReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.#sseAbort) {
        const { done, value } = await reader.read();
        if (done || !this.#sseAbort || this.#sseReader !== reader) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || "";
        for (const part of parts) {
          if (sessionVersion !== this.#sessionVersion) break;
          await this.#handleSseMessage(part, sessionVersion);
        }
      }
    } finally {
      if (this.#sseReader === reader) this.#sseReader = null;
      reader.releaseLock?.();
    }
  }

  async #handleSseMessage(raw, sessionVersion) {
    if (!raw.trim()) return;
    if (/^event:\s*tenant-changed\s*$/m.test(raw)) { this.#closeSse(); this.#adoptExternalTenant(); return; }
    if (/^event:\s*(auth-expired|session-closed)\s*$/m.test(raw)) {
      await this.#expireSession(new ApiClientError("La sesion fue cerrada o expiro", {
        status: 401, response: { ok: false, code: "SESSION_CLOSED" },
      }), sessionVersion);
      return;
    }
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
    this.#clearScheduledServiceSyncs();
    for (const [serviceName, service] of this.#services.entries()) {
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

  #clearScheduledServiceSyncs() {
    for (const timer of this.#scheduledServiceSyncs.values()) clearTimeout(timer);
    this.#scheduledServiceSyncs.clear();
  }

  #log(...args) {
    if (!this.#logging) return;
    const logger = this.#logging === true ? console : this.#logging;
    logger.log?.("[api-client]", ...args);
  }
}

export { ApiClient, ApiClientError, BaseAdapter, BaseService, IndexedDbAdapter, LocalStorageAdapter, MapAdapter, PendingService, SchemaService, SessionService, createAdapter, createApiClient };
//# sourceMappingURL=api-client.js.map
