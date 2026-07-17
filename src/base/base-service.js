import { NotFoundError } from "../errors/not-found-error.js";
import { ValidationError } from "../errors/validation-error.js";

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

  async get(args = {}) {
    return this.getById(args);
  }

  async getById({ params, query, body, context, transaction } = {}) {
    const instance = await this.#model.findByPk(params.id, {...(transaction && { transaction })});
    if (!instance) throw new NotFoundError(this.#resourceName());
    return { data: instance.toJSON() };
  }

  async schema() {
    return {
      data: Object.fromEntries(
        Object.entries(this.#schemas).map(([name, schema]) => [name, this.#toJsonSchema(schema, name)]),
      ),
    };
  }

  async create({ params, query, body, context, transaction } = {}) {
    const data = await this.#validateBody("create", body);
    const instance = await this.#model.create(data, { ...(transaction && { transaction })});
    return { data: instance.toJSON() };
  }

  async update({ params, query, body, context, transaction } = {}) {
    const instance = await this.#model.findByPk(params.id, { ...(transaction && { transaction }),});
    if (!instance)  throw new NotFoundError(this.#resourceName());
    const data = await this.#validateBody("update", body);
    await instance.update(data, { ...(transaction && { transaction }) });
    return { data: instance.toJSON() };
  }

  async remove({ params, query, body, context, transaction } = {}) {
    const instance = await this.#model.findByPk(params.id, {...(transaction && { transaction })});
    if (!instance) throw new NotFoundError(this.#resourceName());
    await instance.destroy({ ...(transaction && { transaction }) });
    return { data: instance.toJSON() };
  }

  #toJsonSchema(schema, operation) {
    if (!schema) return {};
    if (typeof schema.toJsonSchema !== "function") return {};
    return this.#enrichJsonSchema(this.#normalizeJsonSchema(schema.toJsonSchema()), operation);
  }

  #enrichJsonSchema(schema, operation) {
    if (!schema?.properties) return schema;

    const enriched = { ...schema, properties: { ...schema.properties } };
    const definitions = this.#config.resource?.definition || this.#model?.resourceDefinition?.attributes || {};

    for (const [field, property] of Object.entries(enriched.properties)) {
      const definition = definitions[field] || this.#model?.rawAttributes?.[field];
      if (!definition) continue;
      if (operation === "create" && definition.create === false) continue;
      if (operation === "update" && definition.update === false) continue;

      enriched.properties[field] = this.#enrichPropertySchema(property, definition);
    }

    return enriched;
  }

  #enrichPropertySchema(property, definition) {
    const enriched = { ...property };
    const type = definition.type;
    const typeName = type?.key || type?.constructor?.name || "";
    const normalized = typeName.toLowerCase();
    const options = type?.options || {};

    if (normalized.includes("string") && options.length !== undefined) {
      enriched.maxLength = options.length;
    }

    if ((normalized.includes("decimal") || normalized.includes("number")) && options.precision !== undefined) {
      enriched.precision = options.precision;
      if (options.scale !== undefined) enriched.scale = options.scale;
    }

    return enriched;
  }

  #normalizeJsonSchema(schema) {
    if (!schema || typeof schema !== "object") return schema;

    const normalized = Array.isArray(schema) ? schema.map((item) => this.#normalizeJsonSchema(item)) : { ...schema };

    if (Array.isArray(normalized.type) && normalized.type.includes("null")) {
      const types = normalized.type.filter((type) => type !== "null");
      normalized.type = types.length === 1 ? types[0] : types;
      normalized.nullable = true;
    }

    if (normalized.properties) {
      normalized.properties = Object.fromEntries(
        Object.entries(normalized.properties).map(([key, value]) => [key, this.#normalizeJsonSchema(value)]),
      );
    }

    if (normalized.items) normalized.items = this.#normalizeJsonSchema(normalized.items);
    if (normalized.oneOf) normalized.oneOf = normalized.oneOf.map((item) => this.#normalizeJsonSchema(item));
    if (normalized.anyOf) normalized.anyOf = normalized.anyOf.map((item) => this.#normalizeJsonSchema(item));
    if (normalized.allOf) normalized.allOf = normalized.allOf.map((item) => this.#normalizeJsonSchema(item));

    return normalized;
  }

  #resourceName() {
    if (typeof this.#config.resourceName === "string") return this.#config.resourceName;
    if (typeof this.#config.title === "string") return this.#config.title;
    if (typeof this.#config.resource === "string") return this.#config.resource;
    return this.#model?.modelName || this.#config.name || "Recurso";
  }

  async #validateBody(operation, body = {}) {
    const schema = this.#schemas[operation] || this.#schemas.body;
    if (!schema) return body;

    try {
      return await schema.validate(body || {});
    } catch (error) {
      throw new ValidationError(error.message, {
        errors: error.errors || null,
        cause: error,
      });
    }
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





