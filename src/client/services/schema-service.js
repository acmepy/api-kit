import { BaseService } from "./base-service.js";

export class SchemaService extends BaseService {
  constructor({ client, prefix, createAdapter }) {
    super({ client, name: "schema", path: "", operations: {}, schemas: {}, prefix, createAdapter });
  }

  async create(data = {}) {
    throw new Error("SchemaService.list no implementado");
  }

  async list() {
    throw new Error("SchemaService.list no implementado");
  }

  async update(name, data = {}) {
    return { ok: true, data: await this.adapter.put(name, { id: name, ...data }) };
  }

  async remove() {
    throw new Error("SchemaService.remove no implementado");
  }

  async pull() {
    throw new Error("SchemaService.pull no implementado");
  }

  async pullOne() {
    throw new Error("SchemaService.pullOne no implementado");
  }

  async push() {
    throw new Error("SchemaService.push no implementado");
  }

  async schema() {
    throw new Error("SchemaService.schema no implementado");
  }

  async loadSchema() {
    throw new Error("SchemaService.loadSchema no implementado");
  }

  async validate() {
    throw new Error("SchemaService.validate no implementado");
  }

  async validateAt() {
    throw new Error("SchemaService.validateAt no implementado");
  }

  async request() {
    throw new Error("SchemaService.request no implementado");
  }

  permissions() {
    throw new Error("SchemaService.permissions no implementado");
  }
}
