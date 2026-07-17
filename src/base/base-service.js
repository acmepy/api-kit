import { NotFoundError } from "../errors/not-found-error.js";

export class BaseService {
  #model;
  #schemas;
  #config;

  constructor({ model, schemas = {}, config = {} }) {
    this.#model = model;
    this.#schemas = schemas;
    this.#config = config;
  }

  get model() {
    return this.#model;
  }

  get schemas() {
    return this.#schemas;
  }

  get config() {
    return this.#config;
  }

  async list({ params, query, body, context, transaction } = {}) {
    const page = Math.max(1, parseInt(query?.page, 10) || 1);
    const maxSize = this.#config.maxSize || 100;
    const size = Math.min(maxSize, Math.max(1, parseInt(query?.size, 10) || 20));
    const [offset, limit ] = [(page - 1) * size, size];
    const where = this.#buildWhere(query);
    const { count, rows } = await this.#model.findAndCountAll({where, limit, offset, order: this.#config.defaultOrder || [],...(transaction && { transaction })});
    const pages = Math.ceil(count / size);
    return {data: rows.map((r) => r.toJSON()), pagination: { page, size, total: count, pages }};
  }

  async getById({ params, query, body, context, transaction } = {}) {
    const instance = await this.#model.findByPk(params.id, {...(transaction && { transaction })});
    if (!instance) throw new NotFoundError(this.#config.resource || "Recurso");
    return { data: instance.toJSON() };
  }

  async create({ params, query, body, context, transaction } = {}) {
    const instance = await this.#model.create(body, { ...(transaction && { transaction })});
    return { data: instance.toJSON() };
  }

  async update({ params, query, body, context, transaction } = {}) {
    const instance = await this.#model.findByPk(params.id, { ...(transaction && { transaction }),});
    if (!instance)  throw new NotFoundError(this.#config.resource || "Recurso");
    await instance.update(body, { ...(transaction && { transaction }) });
    return { data: instance.toJSON() };
  }

  async remove({ params, query, body, context, transaction } = {}) {
    const instance = await this.#model.findByPk(params.id, {...(transaction && { transaction })});
    if (!instance) throw new NotFoundError(this.#config.resource || "Recurso");
    await instance.destroy({ ...(transaction && { transaction }) });
    return { data: instance.toJSON() };
  }

  #buildWhere(query) {
    if (!query) return {};
    const where = {};
    const whitelist = this.#config.filterWhitelist || [];

    for (const [key, value] of Object.entries(query)) {
      if (key === "page" || key === "size") continue;
      if (whitelist.length > 0 && !whitelist.includes(key)) continue;
      where[key] = value;
    }

    return where;
  }
}
