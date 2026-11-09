import yep from "yep";
import { fillPath } from "../utils.js";
import {defaultAdapter} from "../adapters/index.js";
import { ApiClientError } from "../errors.js";

export class BaseService {
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
    const pending = options.pending ?? true;
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
    const pending = options.pending ?? true;
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
    await this.adapter.put(this.keyOf(data) ?? this.#cacheKey(id), data)
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
    const pending = options.pending ?? true;
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
    const sync = this.client.beginSync?.(this.name, "download");
    try {
      const records = [];
      let total = null;
      let nextQuery = { ...query };

      sync?.update({ status: "downloading" });
      while (nextQuery) {
        const response = await this.#send("list", { query: nextQuery });
        const data = Array.isArray(response.data) ? response.data : [];
        records.push(...data);
        const pagination = response.pagination || response.meta?.pagination || response.meta || {};
        const reportedTotal = Number(pagination.total);
        if (pagination.total != null && Number.isFinite(reportedTotal) && reportedTotal >= 0) total = reportedTotal;
        sync?.update({ count: records.length, total });
        nextQuery = this.#nextPageQuery(response, nextQuery);
      }

      if (records.length > 0) await this.adapter.add(records);
      await this.client.markServiceCacheUpdated?.(this.name);
      this.#notify();
      sync?.complete({ count: records.length, total: total ?? records.length, succeeded: records.length });
      return { ok: true, data: records };
    } catch (error) {
      sync?.fail(error);
      throw error;
    }
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
    const sync = this.client.beginSync?.(this.name, "upload");
    try {
      const targets = id === null ? (await this.pending()).data : [await this.adapter.get(this.#cacheKey(id))].filter(Boolean);
      const results = [];
      let failed = 0;
      sync?.update({ status: "uploading", total: targets.length });
      for (const record of targets) {
        const result = await this.#pushOne(record);
        results.push(result);
        if (!result.ok) failed++;
        sync?.update({ count: results.length, succeeded: results.length - failed, failed });
      }
      const errors = results.filter((result) => !result.ok);
      sync?.complete({ count: results.length, total: targets.length, succeeded: results.length - errors.length, failed: errors.length });
      return { ok: errors.length === 0, results, errors };
    } catch (error) {
      sync?.fail(error);
      throw error;
    }
  }

  async pushOne(record) {
    const sync = this.client.beginSync?.(this.name, "upload");
    try {
      sync?.update({ status: "uploading", total: 1 });
      const result = await this.#pushOne(record);
      sync?.complete({ count: 1, total: 1, succeeded: result.ok ? 1 : 0, failed: result.ok ? 0 : 1 });
      return result;
    } catch (error) {
      sync?.fail(error);
      throw error;
    }
  }

  async #pushOne(record) {
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

  async validateDetail(detail, data = {}, operation = "create") {
    const schema = this.#detailSchema(detail, operation);
    return schema ? schema.validate(data) : data;
  }

  async validateDetailAt(detail, attribute, data = {}, operation = "create") {
    const schema = this.#detailSchema(detail, operation);
    return schema ? schema.validateAt(attribute, data) : data?.[attribute];
  }

  #detailSchema(detail, operation) {
    const descriptor = this.details[detail];
    if (!descriptor) throw new Error(`Detalle "${detail}" no disponible en "${this.name}"`);
    const jsonSchema = descriptor.schemas?.[operation];
    if (!jsonSchema) return null;
    const schema = yep.fromJsonSchema({ ...jsonSchema,
      required: jsonSchema.required?.filter(field => ![descriptor.foreignKey].flat().includes(field)),
    });
    this.#applyUniqueRules(schema, jsonSchema, async (field, value, data) => {
      if (value === undefined || value === null) return null;
      const rows = (await this.list()).data.flatMap(record => record[detail] || []);
      const keys = descriptor.primaryKeyAttributes || ["id"];
      const duplicate = rows.some(row => row[field] === value && !keys.every(key =>
        data[key] !== undefined && String(row[key]) === String(data[key])));
      return duplicate ? new Error("Ya existe un registro con este valor") : null;
    });
    return schema;
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

  #applyUniqueRules(schema, jsonSchema, unique = (field, value, data) => this.unique(field, value, data)) {
    for (const [field, property] of Object.entries(jsonSchema?.properties || {})) {
      if (property?.unique !== true || typeof schema.shapeDefinition?.[field]?.unique !== "function") continue;
      schema.shapeDefinition[field].unique((value, attribute, data) => unique(attribute, value, data));
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

