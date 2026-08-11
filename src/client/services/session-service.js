import { BaseService } from "./base-service.js";

export class SessionService extends BaseService {
  constructor({ client, prefix, createAdapter, path = "/session" }) {
    super({client, name: "session", path, operations: { pull: { path, method: "GET" } }, schemas: {}, prefix, createAdapter,});
  }

  async list() {
    const session = await this.adapter.get("session");
    return { ok: true, data: session ? [session] : [], local: true };
  }

  async pull() {
    const response = await this.client.request(this.path, { method: "GET" });
    if (response.data) await this.adapter.put("session", { id: "session", ...response.data });
    return response;
  }

  async get() {
    throw new Error("SessionService.get no implementado");
  }

  async create() {
    throw new Error("SessionService.create no implementado");
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

  async clear() {
    throw new Error("SessionService.clear no implementado");
  }
}
