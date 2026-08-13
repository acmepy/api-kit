import { BaseService } from "./base-service.js";

export class PendingService extends BaseService {
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
