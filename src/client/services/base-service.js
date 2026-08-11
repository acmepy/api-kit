import yep from "yep";
import { fillPath } from "../utils.js";
import {defaultAdapter} from "../adapters/index.js";
let temporaryStorage;

export class BaseService {
  constructor({ client, name, path, operations = {}, schemas = {}, prefix = "api-kit", createAdapter }) {
    this.client = client;
    this.name = name;
    this.path = path;
    this.operations = operations;
    this.schemas = schemas;
    this.prefix = prefix;
    this.adapter = createAdapter?.({ service: name, prefix: this.prefix }) || client.adapter;
  }

  async list() {
    return { ok: true, data: await this.adapter.getAll(), local: true };
  }

  async pending() {
    const result = await this.list();
    return { ...result, data: result.data.filter((record) => record?.pending) };
  }

  async get(id) {
    const data = await this.adapter.get(id);
    return { ok: Boolean(data), data, local: true };
  }

  async create(data = {}, options = {}) {
    const isPending = options.isPending || true;
    const record = await this.validate(data, "create");
    if (!isPending) return { ok: true, data: await this.add(data) }
    data = {...data, id: this.nextTemporaryId(), pending: true, operation:'create', status: "pending", message: "", errors: null };
    await this.adapter.add(data);
    return { ok: true, data:this.push(data.id) };
  }

  async update(id, data = {}, options = {}) {
    const isPending = options.isPending || true;
    const current = await this.adapter.get(id);
    const record = await this.validate({...current, ...data}, "update");
    if(!isPending)return { ok: true, data:await this.adapter.put(id, data) };
    data = {...current, ...data, pending: true, operation:'update', status: "pending", message: "", errors: null };
    await this.adapter.put(id, data)
    return { ok: true, data:this.push(data.id) };
  }

  async remove(id, options = {}) {
    const isPending = options.isPending || true;
    if(isPending) return { ok: true, data:await this.adapter.remove(id) };
    const data = {...await this.adapter.get(id), pending: true, operation:'remove', status: "pending", message: "", errors: null };
    await this.adapter.put(id, data);
    return { ok: true, data:this.push(data.id) };
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
    return { ok: true, data: records };
  }

  async pullOne(id, query = {}) {
    const response = await this.#send("get", { params: { id }, query });
    if (response.data?.id !== undefined) await this.adapter.add(response.data);
    return response;
  }

  async nextTemporaryId() {
    if (!temporaryStorage) temporaryStorage = defaultAdapter({ prefix: this.prefix, service: "temporaryKey" });
    const record = await temporaryStorage.get("temporaryKey");
    const value = Number(record?.value || 0) + 1;
    await temporaryStorage.put("temporaryKey", { id: "temporaryKey", value });
    return value;
  }

  async push(id = null) {
    const targets = id === null ? (await this.pending()) : [await this.adapter.get(id)];
    const results = [];
    for (const record of targets) results.push(await this.#pushRecord(record));
    const errors = results.filter((result) => !result.ok);
    return { ok: errors.length === 0, results, errors };
  }

  async schema() {
    throw new Error('not implemented');
  }

  async validate(data = {}, operation = "create") {
    return data;
  }

  async validateAt(attribute, data = {}, operation = "create") {
    throw new Error('not implemented');
  }

  permissions(operation) {
    return [...(this.operations[operation]?.permissions || [])];
  }

  async #send(operationName, { params = {}, query = {}, body } = {}) {
    const operation = this.operations[operationName];
    if (!operation) throw new Error(`Operacion "${operationName}" no disponible en "${this.name}"`);
    return this.client.request(fillPath(operation.path, params), { method: operation.method, query, body });
  }

  async clear() {
    await this.adapter.clear();
  }

  async #pushRecord(record) {
    try {
      const response = await this.#sendPendingOperation(record);
      //await this.#applyPushedRecord(record, response);
      return { ok: true, id: record.id, operation: record.operation, response };
    } catch (error) {
      const errors = error.errors || error.response?.errors || null;
      const nextRecord = {...record, pending: true, status: "error", message: error.message, errors};
      await this.adapter.put(record.id, nextRecord);
      return { ok: false, id: record.id, operation: record.operation, error: error.message, errors };
    }
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

function buildYepSchemas(schemas) {
  return Object.fromEntries(
    Object.entries(schemas || {}).map(([name, schema]) => [name, yep.fromJsonSchema(schema)]),
  );
}

function validationResult(result) {
  if (isValidationSummary(result)) return { ok: false, message: result.message, errors: result.errors || {} };
  return { ok: true, message: "OK", errors: null };
}

function isValidationSummary(result) {
  return result && typeof result === "object" && "errors" in result;
}







