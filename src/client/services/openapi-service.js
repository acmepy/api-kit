import { BaseService } from "./base-service.js";

export class OpenapiService extends BaseService {
  constructor({ client, prefix, createAdapter }) {
    super({ client, name: "openapi", path: "", operations: {}, schemas: {}, prefix, createAdapter });
  }

  async create(data = {}) {
    return super.create(data, { isPending: true });
  }

  async list() {
    throw new Error("OpenapiService.list no implementado");
  }

  async update() {
    throw new Error("OpenapiService.update no implementado");
  }

  async remove() {
    throw new Error("OpenapiService.remove no implementado");
  }

  async pull() {
    throw new Error("OpenapiService.pull no implementado");
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

  async clear() {
    throw new Error("OpenapiService.clear no implementado");
  }
}
