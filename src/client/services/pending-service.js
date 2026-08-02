export class PendingService {
  #client;
  #adapter;
  #servicePrefix;

  constructor({ client, adapter, servicePrefix }) {
    this.#client = client;
    this.#adapter = adapter;
    this.#servicePrefix = servicePrefix;
  }

  async list() {
    return (await this.#adapter.get(this.#pendingKey())) || [];
  }

  async get(id) {
    return (await this.list()).find((item) => Number(item.id) === Number(id)) || null;
  }

  async create(operation = {}) {
    const pending = await this.list();
    const nextPending = [...pending.filter((item) => Number(item.id) !== Number(operation.id)), operation];
    await this.#adapter.set(this.#pendingKey(), nextPending);
    return operation;
  }

  async update(id, patch = {}) {
    const pending = await this.list();
    const nextPending = pending.map((item) => (Number(item.id) === Number(id) ? { ...item, ...patch } : item));
    await this.#adapter.set(this.#pendingKey(), nextPending);
    return nextPending.find((item) => Number(item.id) === Number(id)) || null;
  }

  async remove(id) {
    const pending = await this.list();
    const nextPending = pending.filter((item) => Number(item.id) !== Number(id));
    await this.#adapter.set(this.#pendingKey(), nextPending);
    return nextPending;
  }

  async nextTemporaryId() {
    const key = this.#temporaryIdKey();
    const nextId = Number((await this.#adapter.get(key)) || 0) - 1;
    await this.#adapter.set(key, nextId);
    return nextId;
  }

  async resend(id = null, options = {}) {
    if (options.discover !== false && !this.#client.services().size) await this.#client.syncServices();
    const pending = await this.list();
    const targets = id === null ? pending : pending.filter((item) => Number(item.id) === Number(id));
    const results = [];

    for (const operation of targets) {
      results.push(await this.#resendOperation(operation, options));
    }

    const errors = results.filter((result) => !result.ok);
    return { ok: errors.length === 0, results, errors };
  }

  async resendAll() {
    return this.resend();
  }

  async clear() {
    await this.#adapter.remove(this.#pendingKey());
    await this.#adapter.remove(this.#temporaryIdKey());
  }

  async #resendOperation(operation, options = {}) {
    const service = this.#client.service(operation.service);

    try {
      let response;
      if (operation.operation === "create") {
        response = await service.request("create", { body: operation.data });
      } else if (operation.operation === "update") {
        response = await service.request("update", { params: { id: operation.serverId || operation.localId }, body: operation.data });
      } else if (operation.operation === "remove") {
        response = await service.request("remove", { params: { id: operation.serverId || operation.localId } });
      } else {
        throw new Error(`Operacion pendiente "${operation.operation}" no soportada`);
      }

      await this.remove(operation.id);
      if (operation.operation === "create") {
        await this.#client.removeServiceRecord(operation.service, operation.localId ?? operation.id);
        if (response.data?.id !== undefined) await this.#client.addServiceRecord(operation.service, response.data);
      } else if (operation.operation === "update") {
        if (response.data?.id !== undefined) await this.#client.addServiceRecord(operation.service, response.data);
      }
      return { ok: true, id: operation.id, response };
    } catch (error) {
      if (options.throwAuthErrors && error?.status === 401) throw error;
      const errors = error.errors || error.response?.errors || null;
      await this.update(operation.id, { status: "error", message: error.message, errors });
      const localId = operation.localId ?? operation.id;
      const localRecord = { ...operation.data, id: localId, pending: true, status: "error", message: error.message, errors };
      await this.#client.addServiceRecord(operation.service, localRecord);
      return { ok: false, id: operation.id, error: error.message, errors };
    }
  }

  #temporaryIdKey() {
    return `${this.#servicePrefix}:temporaryId`;
  }

  #pendingKey() {
    return `${this.#servicePrefix}:pending`;
  }
}
