import { NotFoundError } from "../errors/not-found-error.js";
import { ValidationError } from "../errors/validation-error.js";
import { normalizeJsonSchema } from "../utils/normalize.js";
import { Op } from "seq";
import yep from 'yep'
import { getContext } from "../context/request-context.js";

const FILTER_OPERATORS = {eq: Op.eq, equal: Op.eq, igual: Op.eq, gt: Op.gt, greater: Op.gt, mayor: Op.gt, gte: Op.gte, greaterOrEqual: Op.gte, mayorIgual: Op.gte, lt: Op.lt, less: Op.lt, menor: Op.lt, lte: Op.lte, lessOrEqual: Op.lte, menorIgual: Op.lte, like: Op.like, notLike: Op.notLike, in: Op.in, incluido: Op.in, between: Op.between};
const FILTER_OPERATOR_NAMES = new Map(Object.entries(FILTER_OPERATORS).map(([name, op]) => [op, name]));
const RANGE_OPERATORS = new Set([Op.gt, Op.gte, Op.lt, Op.lte, Op.between]);
const TYPES_COMPARABLES = ["integer", "decimal", "number", "date", "string"]
const isComparable = (type)=>TYPES_COMPARABLES.includes(type);

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

  async list({ params, query, body, transaction=null } = {}) {
    const context = getContext();
    const page = Math.max(1, parseInt(query?.page, 10) || 1);
    const maxSize = this.#config.maxSize || 100;
    const limit = Math.min(maxSize, Math.max(1, parseInt(query?.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const where = await this.#buildWhere(query);
    //const include = this.#detailDescriptors().map((descriptor) => ({ model: descriptor.target, as: descriptor.as }));
    const include = this.#model.getAssociationIncludes();
    const { count, rows } = await this.#model.findAndCountAll({where, limit, offset, order: this.#config.defaultOrder || [], include: include.length ? include : undefined, distinct: Boolean(include.length), plain: true, ...(transaction && { transaction })});
    const pages = Math.ceil(count / limit);
    return { data: rows, pagination: this.#buildPagination({ page, limit, offset, total: count, pages, baseUrl: context?.baseUrl }) };
  }

  async get({ params, query, body, transaction =null } = {}) {
    const context = getContext();
    const instance = await this.#model.findByPk(params.id, { plain: true, ...(transaction && { transaction }) });
    //if (!instance) throw new NotFoundError(this.#resourceName());
    if (!instance) throw new NotFoundError(this.#model.modelName)
    return { data: instance };
  }

  async schema() {
    return {
      data: Object.fromEntries(
        Object.entries(this.#schemas).map(([name, schema]) => [name, this.#toJsonSchema(schema, name)]),
      ),
    };
  }

  async create({ params, query, body, transaction=null } = {}) {
    const context = getContext();
    const { masterBody, include, hasDetails } = this.#masterDetailsContext(body);
    const data = await this.#schemas.create.validate(masterBody);
    const payload = hasDetails ? { ...body, ...data } : data;
    const instance = await this.#model.create(payload, { ...(hasDetails && { include }), ...(transaction && { transaction })});
    return { data: instance.toJSON() };
  }

  async update({ params, query, body, transaction=null } = {}) {
    const context = getContext();
    const { masterBody, include, hasDetails } = this.#masterDetailsContext(body);
    //const pk = this.#primaryKeyAttribute();
    const pk = this.#model.primaryKeyAttribute;
    const data = await this.#schemas.update.validate(masterBody);
    const payload = hasDetails ? { ...(body || {}), ...data, [pk]: params.id } : data;
    const [instance] = await this.#model.update(payload, { where:{[pk]:params.id}, ...(hasDetails && { include }), ...(transaction && { transaction })});
    return { data: instance?.toJSON() || payload };
  }

  async remove({ params, query, body, transaction=null } = {}) {
    const context = getContext();
    const instance = await this.#model.findByPk(params.id, {...(transaction && { transaction })});
    //if (!instance) throw new NotFoundError(this.#resourceName());
    if (!instance) throw new NotFoundError(this.#model.modelName)
    await instance.destroy({...(transaction && { transaction }) });
    return { data: instance.toJSON() };
  }

  async createDetail({ params, query, body, transaction=null } = {}) {
    const context = getContext();
    //const {target, foreignKey} = this.#detailDescriptor(params.detail);
    const {model:target, foreignKey} = this.#model.getAssociationIncludes().find(a=>a.as==params.detail);
    const parentId = Number.isNaN(Number(params.id)) ? params.id : Number(params.id);
    const data = await target.resourceSchemas.create.validate(body)
    const instance = await target.create({...data, [foreignKey]:parentId}, {...(transaction&&{transaction})})
    return {data:instance.toJSON()}
  }

  async updateDetail({ params, query, body, transaction=null } = {}) {
    const context = getContext();
    //const {name, target, primaryKey, foreignKey} = this.#detailDescriptor(params.detail);
    const {model:target, foreignKey} = this.#model.getAssociationIncludes().find(a=>a.as==params.detail)
    const [name, primaryKey] = [params.detail, target?.primaryKeyAttribute||id];
    const data = await target.resourceSchemas.update.validate(body)
    const where = {[primaryKey]:params.detailId||body[primaryKey], [foreignKey]:params.id}
    const [instance] = await target.update(data, {where, ...(transaction&&{transaction})})
    if (!instance) throw new NotFoundError(name);
    return {data:instance?.toJSON()}
  }

  async removeDetail({ params, query, body, transaction=null } = {}) {
    const context = getContext();
    //const {name, target, primaryKey, foreignKey} = this.#detailDescriptor(params.detail);
    const {model:target, foreignKey} = this.#model.getAssociationIncludes().find(a=>a.as==params.detail)
    const [name, primaryKey] = [params.detail, target?.primaryKeyAttribute||id];
    const where = {[primaryKey]:params.detailId||body?.[primaryKey], [foreignKey]:params.id}
    const instance = await target.findOne({where, ...(transaction&&{transaction})})
    if (!instance) throw new NotFoundError(name);
    const data = instance.toJSON();
    const removed = await target.destroy({where, auditOld:data, ...(transaction&&{transaction})})
    if (!removed) throw new NotFoundError(name);
    return {data}
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
    //const descriptors = detailNames ? detailNames.map((name) => this.#detailDescriptor(name)) : this.#detailDescriptors();
    //const include = descriptors.map((descriptor) => ({ model: descriptor.target, as: descriptor.as }))
    const include = this.#model.getAssociationIncludes();
    
    return { masterBody, include, hasDetails: true };
  }

  /*#detailDescriptors() {
    return Object.keys(this.#detailsConfig()).map((name) => this.#detailDescriptor(name));
  }*/

  /*#detailDescriptor(name) {
    const detailsConfig = this.#detailsConfig();
    const config = detailsConfig[name];
    if (!config) throw new ValidationError(`Detalle "${name}" no estÃ¡ configurado`, { errors: { detail: "No configurado" } });

    const associationName = typeof config === "string" ? config : config.association || config.as || name;
    const association = this.#association(associationName);
    if (!association || association.type !== "hasMany") throw new ValidationError(`Detalle "${name}" debe usar una asociaciÃ³n hasMany`);

    return {
      name,
      association,
      as: association.as || associationName,
      target: association.target,
      foreignKey: association.foreignKey,
      primaryKey: association.target?.primaryKeyAttribute || "id",
      parentPrimaryKey: association.source?.primaryKeyAttribute || this.#primaryKeyAttribute(),
    };
  }
*/
/*
  #association(name) {
    if (this.#model?.associations?.[name]) return this.#model.associations[name];
    return [...new Set(Object.values(this.#model?.associations || {}))].find((association) => association?.as === name) || null;
  }
*/
  #detailsConfig() {
    if (!this.#config.details || typeof this.#config.details !== "object" || Array.isArray(this.#config.details)) return {};
    return this.#config.details;
  }

  #toJsonSchema(schema, operation) {
    if (!schema) return {};
    if (typeof schema.toJsonSchema !== "function") return {};
    return schema.toJsonSchema()
    //return this.#enrichJsonSchema(normalizeJsonSchema(schema.toJsonSchema()), operation);
  }
/*
  #enrichJsonSchema(schema, operation) {
    if (!schema?.properties) return schema;

    const enriched = { ...schema, properties: { ...schema.properties } };
    const definitions = this.#config.resource?.definition || this.#model?.resourceDefinition?.attributes || {};

    for (const [field, property] of Object.entries(enriched.properties)) {
      const definition = definitions[field];
      if (!definition) continue;
      if (operation === "create" && definition.create === false) continue;
      if (operation === "update" && definition.update === false) continue;

      enriched.properties[field] = this.#enrichPropertySchema(property, definition);
    }

    return enriched;
  }
*/
/*
  #enrichPropertySchema(property, definition) {
    const enriched = { ...property };
    const type = definition.type;
    const typeName = type?.key || type?.constructor?.name || "";
    const normalized = typeName.toLowerCase();
    const options = type?.options || {};
    if (normalized.includes("string") && options.length !== undefined) enriched.maxLength = options.length;
    if ((normalized.includes("decimal") || normalized.includes("number")) && options.precision !== undefined) {
      enriched.precision = options.precision;
      if (options.scale !== undefined) enriched.scale = options.scale;
    }
    return enriched;
  }
*/
  /*
  #resourceName() {
    if (typeof this.#config.resourceName === "string") return this.#config.resourceName;
    if (typeof this.#config.title === "string") return this.#config.title;
    if (typeof this.#config.resource === "string") return this.#config.resource;
    return this.#model?.modelName || this.#config.name || "Recurso";
  }
  */

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
      //const filters = this.#queryFilters(key, value);
      const [tmp, attribute, operator='eq'] = key.match(/^([a-zA-Z0-9]+)\[([a-zA-Z0-9]+)\]$/)||['', key];
      if (!FILTER_OPERATORS[operator]) throw new ValidationError(`Operador de filtro "${operator}" no está soportado`);
      const filters = [{field:attribute, operator: FILTER_OPERATORS[operator], value}]
      for (const filter of filters) {
        if (whitelist.length > 0 && !whitelist.includes(filter.field)) continue;
        const definition = definitions[filter.field];
        if (!definition && Object.keys(definitions).length > 0) throw new ValidationError(`Filtro "${filter.field}" no está permitido`);
        const parsedValue = await this.#parseFilterValue(filter.field, filter.operator, filter.value, definition);
        if (filter.operator === Op.eq) {
          where[filter.field] = parsedValue;
          continue;
        }
        andFilters.push({ [filter.field]: { [filter.operator]: parsedValue } });
      }
    }

    if (andFilters.length > 0) where[Op.and] = andFilters;
    return where;
  }

  /*#queryFilters(key, value) {
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      const symbolFilters = Object.getOwnPropertySymbols(value).map((operator) => ({ field: key, operator, value: value[operator] }));
      const namedFilters = Object.entries(value).map(([operatorName, operatorValue]) => {
        const operator = FILTER_OPERATORS[operatorName];
        if (!operator) throw new ValidationError(`Operador de filtro "${operatorName}" no está soportado`);
        return { field: key, operator, value: operatorValue };
      });
      return [...symbolFilters, ...namedFilters];
    }

    return [{ ...this.#parseFilterKey(key), value }];
  }*/

  #parseFilterKey(key) {
    const normalizedKey = String(key);
    const bracket = normalizedKey.match(/^(.+)\[([^\]]+)\]$/);
    const dotted = normalizedKey.match(/^(.+)\.([^.]+)$/);
    const underscored = normalizedKey.match(/^(.+)__([^_]+)$/);
    const match = bracket || dotted || underscored;
    const field = match ? match[1] : normalizedKey;
    const operatorName = match ? match[2] : "eq";
    const operator = FILTER_OPERATORS[operatorName];

    if (!operator) throw new ValidationError(`Operador de filtro "${operatorName}" no está soportado`);
    return { field, operator };
  }

  async #parseFilterValue(field, operator, value, definition) {
    if ([Op.in, Op.between].includes(operator)) {
      const values = this.#splitFilterValues(value);
      if (values.length === 0) throw new ValidationError(`Filtro "${field}" in requiere al menos un valor`);
      if (operator === Op.between && values.length !== 2)  throw new ValidationError(`Filtro "${field}" between requiere dos valores`);
      let parsedValues = [];
      for(const item of values) parsedValues.push(await this.#castFilterValue(field, item, definition))
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
    if(!isComparable(this.#filterType(definition)) && RANGE_OPERATORS.has(operator)) throw new ValidationError(`Filtro "${field}" no soporta operador "${FILTER_OPERATOR_NAMES.get(operator)}"`);
    /*if (!RANGE_OPERATORS.has(operator) || !definition) return;
    const type = this.#filterType(definition);
    const isComparable = ["integer", "decimal", "number", "date", "string"].includes(type);
    if (!isComparable) {
      const operatorName = FILTER_OPERATOR_NAMES.get(operator) || "filtro";
      throw new ValidationError(`Filtro "${field}" no soporta operador "${operatorName}"`);
    }*/
  }

  async #castFilterValue(field, value, definition) {
    const type = this.#filterType(definition);
    const schema = yep.fromJsonSchema({type: 'object', properties: {[field]:{type}}})
    return await schema.validateAt(field, {[field]:value});
  }

  #filterType(definition) {
    return (definition?.type?.key||definition?.type).toLowerCase();
  }
}
