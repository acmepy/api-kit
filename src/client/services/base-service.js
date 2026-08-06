import yep from "yep";
import { fillPath } from "../utils.js";

export class BaseService {
  constructor({ client, name, path, operations = {}, schemas = {}, servicePrefix = "api-kit" }) {
    this.client = client;
    this.name = name;
    this.path = path;
    this.operations = operations;
    this.schemas = schemas;
    this.servicePrefix = servicePrefix;
    this.yepSchemas = buildYepSchemas(schemas);
  }

  async list() {
    return { ok: true, data: await this.#localList(), local: true };
  }

  async get(id) {
    const record = await this.#localGet(id);
    return { ok: Boolean(record), data: record, local: true };
  }

  async create(data = {}, options = {}) {
    if (options.isPending) {
      await this.#localCreate(data);
      return { ok: true, data, local: true };
    }

    const validation = await this.validate(data);
    if (!validation.ok) return validation;

    const pendingService = this.client.service("pending");
    const temporaryId = await pendingService.nextTemporaryId();
    const localRecord = { ...data, id: temporaryId, pending: true, status: "pending", message: "", errors: null };
    const pending = {
      id: temporaryId,
      service: this.name,
      operation: "create",
      localId: temporaryId,
      data,
      status: "pending",
      message: "",
      errors: null,
      createdAt: new Date().toISOString(),
    };

    await this.#localCreate(localRecord);
    await pendingService.create(pending, { isPending: true });
    const pushedData = await this.#pushIfOnlineData(pending.id);
    if (pushedData) return { ok: true, data: pushedData, pending: false, local: true };

    return { ok: true, data: localRecord, pending: true, local: true };
  }

  async update(id, data = {}, options = {}) {
    if (options.isPending) {
      const record = await this.#localUpdate(id, data);
      return { ok: true, data: record, local: true };
    }

    const pendingService = this.client.service("pending");
    const numericId = Number(id);
    if (numericId < 0) {
      const current = await this.#localGet(numericId) || {};
      const pending = (await pendingService.list()).data.find((item) => Number(item.id) === numericId) || {};
      const localRecord = { ...current, ...data, id: numericId, pending: true, status: "pending", message: "", errors: null };
      await this.#localCreate(localRecord);
      await pendingService.update(numericId, { data: { ...(pending.data || {}), ...data }, status: "pending", message: "", errors: null }, { isPending: true });
      const pushedData = await this.#pushIfOnlineData(numericId);
      if (pushedData) return { ok: true, data: pushedData, pending: false, local: true };
      return { ok: true, data: localRecord, pending: true, local: true };
    }

    const current = await this.#localGet(numericId) || {};
    const existingPending = (await pendingService.list()).data.find((item) => item.service === this.name && item.operation === "update" && Number(item.localId) === numericId);
    const localRecord = { ...current, ...data, id: numericId, pending: true, status: "pending", message: "", errors: null };

    await this.#localCreate(localRecord);
    if (existingPending) {
      await pendingService.update(existingPending.id, { data: { ...(existingPending.data || {}), ...data }, status: "pending", message: "", errors: null }, { isPending: true });
      const pushedData = await this.#pushIfOnlineData(existingPending.id);
      if (pushedData) return { ok: true, data: pushedData, pending: false, local: true };
    } else {
      const pendingId = await pendingService.nextTemporaryId();
      const pending = {
        id: pendingId,
        service: this.name,
        operation: "update",
        localId: numericId,
        data,
        status: "pending",
        message: "",
        errors: null,
        createdAt: new Date().toISOString(),
      };
      await pendingService.create(pending, { isPending: true });
      const pushedData = await this.#pushIfOnlineData(pending.id);
      if (pushedData) return { ok: true, data: pushedData, pending: false, local: true };
    }

    return { ok: true, data: localRecord, pending: true, local: true };
  }

  async remove(id, options = {}) {
    if (options.isPending) {
      const record = await this.#localGet(id);
      await this.#localRemove(id);
      return { ok: true, data: record || { id }, local: true };
    }

    const pendingService = this.client.service("pending");
    const numericId = Number(id);
    if (numericId < 0) {
      await pendingService.remove(numericId, { isPending: true });
      await this.#localRemove(numericId);
      return { ok: true, data: { id: numericId }, local: true };
    }

    const current = await this.#localGet(numericId) || { id: numericId };
    const pendingId = await pendingService.nextTemporaryId();
    const pending = {
      id: pendingId,
      service: this.name,
      operation: "remove",
      localId: numericId,
      data: current,
      status: "pending",
      message: "",
      errors: null,
      createdAt: new Date().toISOString(),
    };

    await this.#localRemove(numericId);
    await pendingService.create(pending, { isPending: true });
    const pushedData = await this.#pushIfOnlineData(pending.id);
    if (pushedData) return { ok: true, data: pushedData, pending: false, local: true };

    return { ok: true, data: current, pending: true, local: true };
  }

  async pull(query = {}) {
    const response = await this.#send("list", { query });
    await this.#localReplace(response.data || []);
    return response;
  }

  async pullOne(id, query = {}) {
    const response = await this.#send("get", { params: { id }, query });
    if (response.data?.id !== undefined) await this.#localCreate(response.data);
    return response;
  }

  async push(pendingId = null) {
    const pendingService = this.client.service("pending");
    return pendingService.push(pendingId, { discover: false, service: this.name });
  }

  async schema() {
    await this.loadSchema();
    return { ok: true, data: this.schemas, local: !this.#hasSchemas() };
  }

  async loadSchema() {
    await this.#ensureSchemas({ force: true });
    return this.schemas;
  }

  async validate(data = {}, operation = "create") {
    await this.#ensureSchemas();
    const schema = this.yepSchemas[operation] || this.yepSchemas.body || this.yepSchemas.create;
    if (!schema) return { ok: true, message: "Sin schema", errors: null };
    const result = await schema.validate(data, { safe: true });
    return validationResult(result);
  }

  async validateAt(attribute, data = {}, operation = "create") {
    await this.#ensureSchemas();
    const schema = this.yepSchemas[operation] || this.yepSchemas.body || this.yepSchemas.create;
    if (!schema) return { ok: true, error: null };
    const result = await schema.validateAt(attribute, data, { safe: true });
    if (isValidationSummary(result)) return { ok: false, error: result.errors?.[attribute] || result.message };
    return { ok: true, error: null };
  }

  async request(operation, { params = {}, query = {}, body } = {}) {
    return this.#send(operation, { params, query, body });
  }

  permissions(operation) {
    return [...(this.operations[operation]?.permissions || [])];
  }

  async #send(operationName, { params = {}, query = {}, body } = {}) {
    const operation = this.operations[operationName];
    if (!operation) throw new Error(`Operacion "${operationName}" no disponible en "${this.name}"`);
    return this.client.request(fillPath(operation.path, params), { method: operation.method, query, body });
  }

  async #pushIfOnlineData(pendingId) {
    if (!this.client.connected?.()) return null;
    const result = await this.push(pendingId);
    const response = result?.results?.find((item) => item?.ok)?.response;
    return response?.data || null;
  }

  async #localList() {
    return (await this.client.adapter.get(this.#localKey())) || [];
  }

  async #localGet(id) {
    return (await this.#localList()).find((item) => String(item?.id) === String(id)) || null;
  }

  async #localCreate(record = {}) {
    const records = await this.#localList();
    const nextRecords = [...records.filter((item) => String(item?.id) !== String(record.id)), record];
    await this.#localReplace(nextRecords);
    return record;
  }

  async #localUpdate(id, patch = {}) {
    const current = await this.#localGet(id) || {};
    const record = { ...current, ...patch, id: current.id ?? id };
    await this.#localCreate(record);
    return record;
  }

  async #localRemove(id) {
    const records = await this.#localList();
    const nextRecords = records.filter((item) => String(item?.id) !== String(id));
    await this.#localReplace(nextRecords);
    return nextRecords;
  }

  async #localReplace(records = []) {
    await this.client.adapter.set(this.#localKey(), records);
    return records;
  }

  async clear() {
    await this.client.adapter.remove(this.#localKey());
    await this.#removeCachedSchema();
  }

  async #ensureSchemas(options = {}) {
    if (!options.force && this.#hasSchemas()) return;

    if (this.operations.schema) {
      try {
        const response = await this.#send("schema");
        this.#setSchemas(response.data || {});
        await this.#setCachedSchema(this.schemas);
        return;
      } catch {
        const fallback = await this.#getCachedSchema();
        if (fallback) this.#setSchemas(fallback);
        return;
      }
    }

    const cached = await this.#getCachedSchema();
    if (cached) this.#setSchemas(cached);
  }
  #setSchemas(schemas = {}) {
    this.schemas = schemas || {};
    this.yepSchemas = buildYepSchemas(this.schemas);
  }

  #hasSchemas() {
    return Object.keys(this.schemas || {}).length > 0;
  }

  #localKey() {
    return `${this.servicePrefix}:${this.name}`;
  }

  async #getCachedSchema() {
    const schemas = await this.client.adapter.get(this.#schemasKey());
    return schemas?.[this.name] || null;
  }

  async #setCachedSchema(schema) {
    const schemas = await this.client.adapter.get(this.#schemasKey()) || {};
    await this.client.adapter.set(this.#schemasKey(), { ...schemas, [this.name]: schema });
  }

  async #removeCachedSchema() {
    const schemas = await this.client.adapter.get(this.#schemasKey());
    if (!schemas || !(this.name in schemas)) return;
    const nextSchemas = { ...schemas };
    delete nextSchemas[this.name];
    if (Object.keys(nextSchemas).length === 0) await this.client.adapter.remove(this.#schemasKey());
    else await this.client.adapter.set(this.#schemasKey(), nextSchemas);
  }

  #schemasKey() {
    return `${this.servicePrefix}:schema`;
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







