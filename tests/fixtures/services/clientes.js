import { BaseService, NotFoundError } from "../../../src/server/index.js";

export default class ClientesService extends BaseService {
  async ruc({ params } = {}) {
    const row = await this.model.findOne({ where: { ruc: params.ruc } });
    if (!row) throw new NotFoundError("Cliente");
    return { data: row.toJSON() };
  }
}
