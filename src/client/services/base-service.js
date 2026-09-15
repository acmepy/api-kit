import yep from "yep";
import { fillPath } from "../utils.js";
import {defaultAdapter} from "../adapters/index.js";
let temporaryStorage;

export class BaseService {
  constructor({ client, name, path, operations = {}, schemas = {}, prefix = "api", createAdapter }) {
    this.client = client;
    this.name = name;
    this.path = path;
    this.operations = operations;
    this.schemas = Object.keys(schemas).length > 0 ? schemas : null;
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
    await this.adapter.put(data.id ?? id, data)
    this.#notify();
    const ret = await this.pushOne(data);
    this.#throwPushError(ret);
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

