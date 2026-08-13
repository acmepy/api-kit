import { BaseService } from "./base-service.js";

export class OpenapiService extends BaseService {
  constructor({ client, prefix, createAdapter, path = "/openapi.json" }) {
    super({ client, name: "openapi", path, operations: {}, schemas: {}, prefix, createAdapter });
  }

  async list() {
    throw new Error("OpenapiService.list no implementado");
  }

  async create(data = {}) {
    throw new Error("OpenapiService.list no implementado");
  }

  async update() {
    throw new Error("OpenapiService.update no implementado");
  }

  async remove() {
    throw new Error("OpenapiService.remove no implementado");
  }

  async pull() {
    const records = await this.client.request(this.path, { method: "GET", cache: "no-store" });
    await this.adapter.clear();
    await this.adapter.put("document", records);
    return records;
  }

  async pullOne() {
    throw new Error("OpenapiService.pullOne no implementado");
  }

  async push() {
    throw new Error("OpenapiService.push no implementado");
  }

  async schema() {
    throw new Error("OpenapiService.schema no implementado");
  }

  async loadSchema() {
    throw new Error("OpenapiService.loadSchema no implementado");
  }

  async validate() {
    throw new Error("OpenapiService.validate no implementado");
  }

  async validateAt() {
    throw new Error("OpenapiService.validateAt no implementado");
  }

  async request() {
    throw new Error("OpenapiService.request no implementado");
  }

  permissions() {
    throw new Error("OpenapiService.permissions no implementado");
  }

}
