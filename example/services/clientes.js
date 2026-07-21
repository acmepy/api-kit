import { BaseService, NotFoundError } from "../../src/index.js";

export default class ClientesService extends BaseService {
  async ruc({ params, transaction } = {}) {
    const instance = await this.model.findOne({
      where: { ruc: params.ruc },
      ...(transaction && { transaction }),
    });

    if (!instance) throw new NotFoundError("Cliente");
    return { data: instance.toJSON() };
  }
}
