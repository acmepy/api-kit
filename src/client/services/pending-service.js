import { ApiKitClientError } from "../errors.js";
import { BaseService } from "./base-service.js";

export class PendingService extends BaseService {
  constructor({ client, servicePrefix }) {
    super({ client, name: "pending", path: "", operations: {}, schemas: {}, servicePrefix });
  }

  async create(operation = {}) {
    return super.create(operation, { isPending: true });
  }

  async update(id, patch = {}) {
    return super.update(id, patch, { isPending: true });
  }

  async remove(id) {
    return super.remove(id, { isPending: true });
  }

  async pull() {
    throw new ApiKitClientError('No implemntado')
  }

  async pullOne(id) {
    return this.get(id);
  }

  async push(pendingId = null, options = {}) {
    if (options.discover !== false && !this.client.services().size) await this.client.syncServices();
    const pending = (await this.list()).data;
    const targets = pending.filter((item) => {
      if (options.service && item.service !== options.service) return false;
      if (pendingId !== null && Number(item.id) !== Number(pendingId)) return false;
      return true;
    });
    const results = [];

    for (const operation of targets) {
      results.push(await this.#resendOperation(operation, options));
    }

    const errors = results.filter((result) => !result.ok);
    return { ok: errors.length === 0, results, errors };
  }

  async nextTemporaryId() {
    const key = this.#temporaryIdKey();
    const nextId = Number((await this.client.adapter.get(key)) || 0) - 1;
    await this.client.adapter.set(key, nextId);
    return nextId;
  }

  async clear() {
    await this.client.adapter.remove(this.#pendingKey());
    await this.client.adapter.remove(this.#temporaryIdKey());
  }

  async #resendOperation(operation, options = {}) {
    const service = this.client.service(operation.service);

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
        await service.remove(operation.localId ?? operation.id, { isPending: true });
        if (response.data?.id !== undefined) await service.create(response.data, { isPending: true });
      } else if (operation.operation === "update") {
        if (response.data?.id !== undefined) await service.create(response.data, { isPending: true });
      } else if (operation.operation === "remove") {
        await service.remove(operation.localId, { isPending: true });
      }
      return { ok: true, id: operation.id, response };
    } catch (error) {
      if (options.throwAuthErrors && error?.status === 401) throw error;
      const errors = error.errors || error.response?.errors || null;
      await this.update(operation.id, { status: "error", message: error.message, errors });
      const localId = operation.localId ?? operation.id;
      const localRecord = { ...operation.data, id: localId, pending: true, status: "error", message: error.message, errors };
      await service.create(localRecord, { isPending: true });
      return { ok: false, id: operation.id, error: error.message, errors };
    }
  }

  #temporaryIdKey() {
    return `${this.servicePrefix}:temporaryId`;
  }

  #pendingKey() {
    return `${this.servicePrefix}:pending`;
  }
}
