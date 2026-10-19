import { BaseService } from "./base-service.js";

export class PendingService extends BaseService {
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
