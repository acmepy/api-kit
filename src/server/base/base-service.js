import { NotFoundError } from "../errors/not-found-error.js";
import { ValidationError } from "../errors/validation-error.js";
import { Op } from "seq";
import yep from 'yep'
import { getContext } from "../context/request-context.js";
import { nestedSchemaValidationOptions, validateResourceSchema } from "./nested-schema-validation.js";

const FILTER_OPERATORS = { eq: Op.eq, equal: Op.eq, igual: Op.eq, gt: Op.gt, greater: Op.gt, mayor: Op.gt, gte: Op.gte, greaterOrEqual: Op.gte, mayorIgual: Op.gte, lt: Op.lt, less: Op.lt, menor: Op.lt, lte: Op.lte, lessOrEqual: Op.lte, menorIgual: Op.lte, like: Op.like, notLike: Op.notLike, in: Op.in, incluido: Op.in, between: Op.between };
const FILTER_OPERATOR_NAMES = new Map(Object.entries(FILTER_OPERATORS).map(([name, op]) => [op, name]));
const RANGE_OPERATORS = new Set([Op.gt, Op.gte, Op.lt, Op.lte, Op.between]);
const TYPES_COMPARABLES = ["integer", "decimal", "number", "date", "string"]
const isComparable = (type) => TYPES_COMPARABLES.includes(type);

export class BaseService {
  #model;
  #schemas;
  #config;
  #seq;
  #models;
  #services;

  constructor({ model, schemas = {}, config = {}, seq = null, models = null, services = null }) {
    this.#model = model;
    this.#schemas = schemas;
    this.#config = config;
    this.#seq = seq;
    this.#models = models;
    this.#services = services;
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

  get seq() {
    return this.#seq;
  }

  get models() {
    return this.#models;
  }

  get services() {
    return this.#services;
  }

  async list({ params, query, body, transaction = null } = {}) {
    const context = getContext();
    const page = Math.max(1, parseInt(query?.page, 10) || 1);
    const maxSize = this.#config.maxSize || 100;
    const limit = Math.min(maxSize, Math.max(1, parseInt(query?.limit, 10) || maxSize));
    const offset = (page - 1) * limit;
    const where = await this.#buildWhere(query);
    const include = this.#model.getAssociationIncludes();
    const { count, rows } = await this.#model.findAndCountAll({ where, limit, offset, order: this.#config.defaultOrder || [], include: include.length ? include : undefined, distinct: Boolean(include.length), plain: true, ...(transaction && { transaction }) });
    const pages = Math.ceil(count / limit);
    return { data: rows, pagination: this.#buildPagination({ page, limit, offset, total: count, pages, baseUrl: context?.baseUrl }) };
  }

  async get({ params, query, body, transaction = null } = {}) {
    const key = await this.#primaryKey(params, query);
    const instance = await this.#model.findByPk(key, { plain: true, ...(transaction && { transaction }) });
    if (!instance) throw new NotFoundError(this.#model.modelName)
    return { data: instance };
  }

  async schema() {
    return {
      data: Object.fromEntries(Object.entries(this.#schemas).map(([name, schema]) => 
        [name, this.#toJsonSchema(schema, name)]
    ))};
  }

  async create({ params, query, body, transaction = null } = {}) {
    const { masterBody, detailBody, include, hasDetails } = this.#masterDetailsContext(body);
    const data = await validateResourceSchema(this.#schemas.create, masterBody, transaction);
    const payload = hasDetails ? { ...detailBody, ...data } : data;
    const instance = await this.#model.create(payload, { ...(hasDetails && { include, ...nestedSchemaValidationOptions(this.#model, include) }), ...(transaction && { transaction }) });
    return { data: instance.toJSON() };
  }

  async update({ params, query, body, transaction = null } = {}) {
    const { masterBody, detailBody, include, hasDetails } = this.#masterDetailsContext(body);
    const pk = this.#model.primaryKeyAttribute;
    const key = await this.#primaryKey(params, query);
    const composite = typeof key === "object" && key !== null;
    const where = composite ? key : { [pk]: key };
    if (composite) {
      for (const [field, value] of Object.entries(key)) {
        if (masterBody?.[field] !== undefined && await this.#castFilterValue(field, masterBody[field], this.#model.rawAttributes[field]) !== value) {
          throw new ValidationError(`No se puede modificar la clave primaria "${field}"`);
        }
      }
    }
    const data = await validateResourceSchema(this.#schemas.update, { ...masterBody, __uniqueId: key }, transaction);
    const payload = hasDetails ? { ...detailBody, ...data, ...where } : data;
    await this.#model.update(payload, { where, ...(hasDetails && { include, ...nestedSchemaValidationOptions(this.#model, include) }), ...(transaction && { transaction }) });
    const instance = await this.#model.findByPk(composite ? key : data[pk] ?? key, { plain: true, ...(hasDetails && { include }), ...(transaction && { transaction }) });
    if (!instance) throw new NotFoundError(this.#model.modelName);
    return { data: instance };
  }

  async remove({ params, query, body, transaction = null } = {}) {
    const key = await this.#primaryKey(params, query);
    const instance = await this.#model.findByPk(key, { ...(transaction && { transaction }) });
    if (!instance) throw new NotFoundError(this.#model.modelName)
    await instance.destroy({ ...(transaction && { transaction }) });
    return { data: instance.toJSON() };
  }

  async createDetail({ params, query, body, transaction = null } = {}) {
    const { model: target, foreignKey } = this.#model.getAssociationIncludes().find(a => a.as == params.detail);
    if (typeof foreignKey !== "string") throw new ValidationError("La ruta de detalle requiere una clave foranea simple");
    const parentId = await this.#castFilterValue(foreignKey, params.id, target.rawAttributes[foreignKey]);
    const data = await validateResourceSchema(target.resourceSchemas.create, { ...body, [foreignKey]: parentId }, transaction)
    const instance = await target.create({ ...data, [foreignKey]: parentId }, { ...(transaction && { transaction }) })
    return { data: instance.toJSON() }
  }

  async updateDetail({ params, query, body, transaction = null } = {}) {
    const { model: target, foreignKey } = this.#model.getAssociationIncludes().find(a => a.as == params.detail)
    const data = await validateResourceSchema(target.resourceSchemas.update, body, transaction)
    const name = params.detail;
    const where = await this.#detailWhere(target, foreignKey, params, body);
    await target.update(data, { where, ...(transaction && { transaction }) })
    const instance = await target.findOne({ where, plain: true, ...(transaction && { transaction }) });
    if (!instance) throw new NotFoundError(name);
    return { data: instance }
  }

  async removeDetail({ params, query, body, transaction = null } = {}) {
    const { model: target, foreignKey } = this.#model.getAssociationIncludes().find(a => a.as == params.detail)
    const name = params.detail;
    const where = await this.#detailWhere(target, foreignKey, params, body);
    const instance = await target.findOne({ where, ...(transaction && { transaction }) })
    if (!instance) throw new NotFoundError(name);
    const data = instance.toJSON();
    const removed = await target.destroy({ where, auditOld: data, ...(transaction && { transaction }) })
    if (!removed) throw new NotFoundError(name);
    return { data }
  }

  async #primaryKey(params = {}, query = {}) {
    const keys = this.#model.primaryKeyAttributes || [this.#model.primaryKeyAttribute];
    if (keys.length <= 1) return params.id;
    const supplied = params.id && typeof params.id === "object" && !Array.isArray(params.id)
      ? params.id : { ...query, [keys[0]]: params.id };
    const key = {};
    for (const field of keys) {
      const value = supplied[field];
      if (value === undefined || value === null || value === "" || typeof value === "object") {
        throw new ValidationError(`Falta o no es valida la clave primaria "${field}"`);
      }
      key[field] = await this.#castFilterValue(field, value, this.#model.rawAttributes[field]);
    }
    return key;
  }

  async #detailWhere(target, foreignKey, params, body) {
    if (typeof foreignKey !== "string") throw new ValidationError("La ruta de detalle requiere una clave foranea simple");
    const keys = target.primaryKeyAttributes.filter((key) => key !== foreignKey);
    if (keys.length !== 1) throw new ValidationError("La ruta de detalle requiere un unico componente de clave ademas de la clave del maestro");
    const primaryKey = keys[0];
    const id = params.detailId ?? body?.[primaryKey];
    if (id === undefined || id === null) throw new ValidationError(`Falta la clave del detalle "${primaryKey}"`);
    return {
      [primaryKey]: await this.#castFilterValue(primaryKey, id, target.rawAttributes[primaryKey]),
      [foreignKey]: await this.#castFilterValue(foreignKey, params.id, target.rawAttributes[foreignKey]),
    };
  }

  #masterDetailsContext(body = {}) {
    const detailsConfig = this.#detailsConfig();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(detailsConfig).length === 0) {
      return { masterBody: body, include: [], hasDetails: false };
    }

    const detailNames = Object.keys(detailsConfig).filter((key) => key in body);
    if (detailNames.length === 0) return { masterBody: body, include: [], hasDetails: false };

    const masterBody = { ...body };
    for (const key of detailNames) delete masterBody[key];
    const include = this.#model.getAssociationIncludes();

    const detailBody = Object.fromEntries(detailNames.map((key) => [key, body[key]]));
    return { masterBody, detailBody, include, hasDetails: true };
  }

  #detailsConfig() {
    if (!this.#config.details || typeof this.#config.details !== "object" || Array.isArray(this.#config.details)) return {};
    return this.#config.details;
  }

  #toJsonSchema(schema, operation) {
    if (!schema) return {};
    if (typeof schema.toJsonSchema !== "function") return {};
    return schema.toJsonSchema()
  }

  #buildPagination({ page, limit, offset, total, pages, baseUrl }) {
    const pagination = { page, limit, offset, total, pages };
    if (!baseUrl) return pagination;

    pagination.links = {
      self: this.#paginationLink(baseUrl, page, limit),
      next: page < pages ? this.#paginationLink(baseUrl, page + 1, limit) : false,
      prev: page > 1 ? this.#paginationLink(baseUrl, page - 1, limit) : false,
    };

    return pagination;
  }

  #paginationLink(baseUrl, page, limit) {
    const url = new URL(baseUrl);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(limit));
    return url.toString();
  }

  async #buildWhere(query) {
    if (!query) return {};
    const where = {};
    const andFilters = [];
    const whitelist = this.#config.filterWhitelist || [];
    const definitions = this.#model.attributes;
    for (const [key, value] of Object.entries(query)) {
      if (["page", "limit"].includes(key)) continue;
      const [, attribute, operator = 'eq'] = key.match(/^([a-zA-Z0-9_]+)\[([a-zA-Z0-9_]+)\]$/) || ['', key];
      if (!FILTER_OPERATORS[operator]) throw new ValidationError(`Operador de filtro "${operator}" no está soportado`);
      if (whitelist.length > 0 && !whitelist.includes(attribute)) continue;
      const definition = definitions[attribute];
      if (!definition && Object.keys(definitions).length > 0) throw new ValidationError(`Filtro "${attribute}" no está permitido`);
      const filterOperator = FILTER_OPERATORS[operator];
      const parsedValue = await this.#parseFilterValue(attribute, filterOperator, value, definition);
      if (filterOperator === Op.eq) {
        where[attribute] = parsedValue;
        continue;
      }
      andFilters.push({ [attribute]: { [filterOperator]: parsedValue } });
    }

    if (andFilters.length > 0) where[Op.and] = andFilters;
    return where;
  }

  async #parseFilterValue(field, operator, value, definition) {
    if ([Op.in, Op.between].includes(operator)) {
      const values = this.#splitFilterValues(value);
      if (values.length === 0) throw new ValidationError(`Filtro "${field}" in requiere al menos un valor`);
      if (operator === Op.between && values.length !== 2) throw new ValidationError(`Filtro "${field}" between requiere dos valores`);
      let parsedValues = [];
      for (const item of values) parsedValues.push(await this.#castFilterValue(field, item, definition))
      this.#assertRangeOperator(field, operator, definition);
      return parsedValues;
    }
    this.#assertRangeOperator(field, operator, definition);
    return await this.#castFilterValue(field, value, definition);
  }

  #splitFilterValues(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return value.split(",").map((item) => item.trim());
    return [value];
  }

  #assertRangeOperator(field, operator, definition) {
    if (!isComparable(this.#filterType(definition)) && RANGE_OPERATORS.has(operator)) throw new ValidationError(`Filtro "${field}" no soporta operador "${FILTER_OPERATOR_NAMES.get(operator)}"`);
  }

  async #castFilterValue(field, value, definition) {
    const type = this.#filterType(definition);
    const schema = yep.fromJsonSchema({ type: 'object', properties: { [field]: { type } } })
    return await schema.validateAt(field, { [field]: value });
  }

  #filterType(definition) {
    return (definition?.type?.key || definition?.type).toLowerCase();
  }
}
