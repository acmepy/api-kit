import yep from "yep";
import { fillPath } from "../utils.js";

export class BaseService {
  constructor({ client, name, path, operations = {}, schemas = {} }) {
    this.client = client;
    this.name = name;
    this.path = path;
    this.operations = operations;
    this.schemas = schemas;
    this.yepSchemas = buildYepSchemas(schemas);
  }

  async list(query = {}) {
    if (!this.client.connected()) {
      return { ok: true, data: await this.client.serviceData(this.name), local: true };
    }

    try {
      const response = await this.#send("list", { query });
      await this.client.setServiceData(this.name, response.data || []);
      return response;
    } catch (error) {
      return { ok: true, data: await this.client.serviceData(this.name), local: true, error: error.message };
    }
  }

  async get(id, query = {}) {
    return this.#send("get", { params: { id }, query });
  }

  async create(data = {}) {
    const validation = await this.validate(data);
    if (!validation.ok) return validation;

    const temporaryId = await this.client.nextTemporaryId();
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

    await this.client.addServiceRecord(this.name, localRecord);
    await this.client.addPending(pending);

    if (!this.client.connected()) {
      return { ok: true, data: localRecord, pending: true, local: true };
    }

    try {
      const response = await this.#send("create", { body: data });
      await this.client.removePending(pending.id);
      await this.client.removeServiceRecord(this.name, temporaryId);
      if (response.data?.id !== undefined) {
        await this.client.addServiceRecord(this.name, response.data);
      }
      return response;
    } catch (error) {
      const errors = error.errors || error.response?.errors || null;
      const errorRecord = { ...localRecord, status: "error", message: error.message, errors };
      await this.client.addServiceRecord(this.name, errorRecord);
      await this.client.updatePending(pending.id, { status: "error", message: error.message, errors });
      return { ok: true, data: errorRecord, pending: true, error: error.message, errors };
    }
  }

  async update(id, data = {}) {
    const numericId = Number(id);
    if (numericId < 0) {
      const records = await this.client.serviceData(this.name);
      const current = records.find((item) => Number(item?.id) === numericId) || {};
      const pending = (await this.client.pending()).find((item) => Number(item.id) === numericId) || {};
      const localRecord = { ...current, ...data, id: numericId, pending: true, status: "pending", message: "", errors: null };
      await this.client.addServiceRecord(this.name, localRecord);
      await this.client.updatePending(numericId, { data: { ...(pending.data || {}), ...data }, status: "pending", message: "", errors: null });
      return { ok: true, data: localRecord, pending: true, local: true };
    }

    const records = await this.client.serviceData(this.name);
    const current = records.find((item) => Number(item?.id) === numericId) || {};
    const pendingId = await this.client.nextTemporaryId();
    const localRecord = { ...current, ...data, id: numericId, pending: true, status: "pending", message: "", errors: null };
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

    await this.client.addServiceRecord(this.name, localRecord);
    await this.client.addPending(pending);

    if (!this.client.connected()) {
      return { ok: true, data: localRecord, pending: true, local: true };
    }

    try {
      const response = await this.#send("update", { params: { id }, body: data });
      await this.client.removePending(pending.id);
      if (response.data?.id !== undefined) await this.client.addServiceRecord(this.name, response.data);
      return response;
    } catch (error) {
      const errors = error.errors || error.response?.errors || null;
      const errorRecord = { ...localRecord, status: "error", message: error.message, errors };
      await this.client.addServiceRecord(this.name, errorRecord);
      await this.client.updatePending(pending.id, { status: "error", message: error.message, errors });
      return { ok: true, data: errorRecord, pending: true, error: error.message, errors };
    }
  }

  async remove(id) {
    const numericId = Number(id);
    if (numericId < 0) {
      await this.client.removePending(numericId);
      await this.client.removeServiceRecord(this.name, numericId);
      return { ok: true, data: { id: numericId }, local: true };
    }

    const records = await this.client.serviceData(this.name);
    const current = records.find((item) => Number(item?.id) === numericId) || { id: numericId };
    const pendingId = await this.client.nextTemporaryId();
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

    await this.client.removeServiceRecord(this.name, numericId);
    await this.client.addPending(pending);

    if (!this.client.connected()) {
      return { ok: true, data: current, pending: true, local: true };
    }

    try {
      const response = await this.#send("remove", { params: { id } });
      await this.client.removePending(pending.id);
      return response;
    } catch (error) {
      const errors = error.errors || error.response?.errors || null;
      const errorRecord = { ...current, pending: true, status: "error", message: error.message, errors };
      await this.client.addServiceRecord(this.name, errorRecord);
      await this.client.updatePending(pending.id, { status: "error", message: error.message, errors });
      return { ok: true, data: errorRecord, pending: true, error: error.message, errors };
    }
  }

  async schema() {
    if (this.operations.schema) return this.#send("schema");
    return { ok: true, data: this.schemas };
  }

  async validate(data = {}, operation = "create") {
    const schema = this.yepSchemas[operation] || this.yepSchemas.body || this.yepSchemas.create;
    if (!schema) return { ok: true, message: "Sin schema", errors: null };
    const result = await schema.validate(data, { safe: true });
    return validationResult(result);
  }

  async validateAt(attribute, data = {}, operation = "create") {
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
