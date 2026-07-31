import { NotFoundError } from "../errors/not-found-error.js";
import { ValidationError } from "../errors/validation-error.js";
import { normalizeJsonSchema } from "../utils/normalize.js";
import { Op } from "seq";

const FILTER_OPERATORS = {eq: Op.eq, equal: Op.eq, igual: Op.eq, gt: Op.gt, greater: Op.gt, mayor: Op.gt, gte: Op.gte, greaterOrEqual: Op.gte, mayorIgual: Op.gte, lt: Op.lt, less: Op.lt, menor: Op.lt, lte: Op.lte, lessOrEqual: Op.lte, menorIgual: Op.lte, like: Op.like, notLike: Op.notLike, in: Op.in, incluido: Op.in, between: Op.between};
const FILTER_OPERATOR_NAMES = new Map(Object.entries(FILTER_OPERATORS).map(([name, op]) => [op, name]));
const RANGE_OPERATORS = new Set([Op.gt, Op.gte, Op.lt, Op.lte, Op.between]);

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

  async list({ params, query, body, context, transaction } = {}) {
    const page = Math.max(1, parseInt(query?.page, 10) || 1);
    const maxSize = this.#config.maxSize || 100;
    const limit = Math.min(maxSize, Math.max(1, parseInt(query?.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const where = this.#buildWhere(query);
    const { count, rows } = await this.#model.findAndCountAll({where, limit, offset, order: this.#config.defaultOrder || [],...(transaction && { transaction })});
    const pages = Math.ceil(count / limit);
    return {
      data: rows.map((r) => r.toJSON()),
      pagination: this.#buildPagination({ page, limit, offset, total: count, pages, baseUrl: context?.baseUrl }),
    };
  }

  async get({ params, query, body, context, transaction } = {}) {
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
    const { body: masterBody, details } = this.#splitDetailsFromBody(body);
    const data = await this.#validateBody("create", masterBody);

    return this.#withTransaction(transaction, async (activeTransaction) => {
      try {
        const instance = await this.#model.create(data, { ...(activeTransaction && { transaction: activeTransaction })});
        await this.#saveDetails(instance, details, { operation: "create", transaction: activeTransaction });
        return { data: await this.#toJsonWithDetails(instance, activeTransaction) };
      } catch (error) {
        throw this.#normalizePersistenceError(error);
      }
    });
  }

  async update({ params, query, body, context, transaction } = {}) {
    const { body: masterBody, details } = this.#splitDetailsFromBody(body);
    const data = await this.#validateBody("update", masterBody);

    return this.#withTransaction(transaction, async (activeTransaction) => {
      const instance = await this.#model.findByPk(params.id, { ...(activeTransaction && { transaction: activeTransaction }),});
      if (!instance)  throw new NotFoundError(this.#resourceName());
      const auditOld = instance.toJSON();
      try {
        let updated = instance;
        if (this.#updatesPrimaryKey(instance, data)) {
          const pk = this.#primaryKeyAttribute();
          await this.#model.update(data, { where: { [pk]: auditOld[pk] }, auditOld, ...(activeTransaction && { transaction: activeTransaction }) });
          updated = await this.#model.findByPk(data[pk], { ...(activeTransaction && { transaction: activeTransaction }) });
        } else if (Object.keys(data || {}).length > 0) {
          await instance.update(data, { auditOld, ...(activeTransaction && { transaction: activeTransaction }) });
        }
        await this.#saveDetails(updated, details, { operation: "update", transaction: activeTransaction });
        return { data: await this.#toJsonWithDetails(updated, activeTransaction) };
      } catch (error) {
        throw this.#normalizePersistenceError(error);
      }
    });
  }

  async createDetail({ params, query, body, context, transaction } = {}) {
    return this.#mutateDetail({ params, body, transaction }, async ({ descriptor, parentId, activeTransaction }) => {
      const payload = await this.#validateDetailBody(descriptor, "create", body, { [descriptor.foreignKey]: parentId });
      const instance = await this.#upsertDetail(descriptor.target, payload, { transaction: activeTransaction });
      return { data: instance.toJSON() };
    });
  }

  async updateDetail({ params, query, body, context, transaction } = {}) {
    return this.#mutateDetail({ params, body, transaction, detailIdRequired: true }, async ({ descriptor, parentId, detailId, activeTransaction }) => {
      await this.#assertDetailBelongsToParent(descriptor, parentId, detailId, activeTransaction);
      const payload = await this.#validateDetailBody(descriptor, "update", body, { [descriptor.primaryKey]: detailId, [descriptor.foreignKey]: parentId });
      const instance = await this.#upsertDetail(descriptor.target, payload, { transaction: activeTransaction });
      return { data: instance.toJSON() };
    });
  }

  async removeDetail({ params, query, body, context, transaction } = {}) {
    return this.#mutateDetail({ params, body, transaction, detailIdRequired: true }, async ({ descriptor, parentId, detailId, activeTransaction }) => {
      const instance = await this.#assertDetailBelongsToParent(descriptor, parentId, detailId, activeTransaction);
      const auditOld = instance.toJSON();
      await instance.destroy({ auditOld, ...(activeTransaction && { transaction: activeTransaction }) });
      return { data: auditOld };
    });
  }

  async remove({ params, query, body, context, transaction } = {}) {
    const instance = await this.#model.findByPk(params.id, {...(transaction && { transaction })});
    if (!instance) throw new NotFoundError(this.#resourceName());
    const auditOld = instance.toJSON();
    try {
      await instance.destroy({ auditOld, ...(transaction && { transaction }) });
      return { data: instance.toJSON() };
    } catch (error) {
      throw this.#normalizePersistenceError(error);
    }
  }

  #splitDetailsFromBody(body = {}) {
    const detailsConfig = this.#detailsConfig();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(detailsConfig).length === 0) {
      return { body, details: new Map() };
    }

    let masterBody = body;
    const details = new Map();

    for (const key of Object.keys(detailsConfig)) {
      if (!(key in body)) continue;
      if (!Array.isArray(body[key])) throw new ValidationError(`Detalle "${key}" debe ser un array`, { errors: { [key]: "Debe ser un array" } });
      if (masterBody === body) masterBody = { ...body };
      details.set(key, body[key]);
      delete masterBody[key];
    }

    return { body: masterBody, details };
  }

  async #withTransaction(transaction, callback) {
    if (transaction || typeof this.#seq?.transaction !== "function") return callback(transaction || null);
    return this.#seq.transaction((activeTransaction) => callback(activeTransaction));
  }

  async #saveDetails(parent, details, { operation, transaction } = {}) {
    if (!parent || !details || details.size === 0) return [];

    const saved = [];
    for (const [name, items] of details.entries()) {
      const descriptor = this.#detailDescriptor(name);
      const parentId = parent.getDataValue(descriptor.parentPrimaryKey);
      const savedForDetail = [];

      for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new ValidationError(`Detalle "${name}" debe contener objetos`);
        const hasPrimaryKey = item[descriptor.primaryKey] !== undefined && item[descriptor.primaryKey] !== null;
        const detailOperation = operation === "update" && hasPrimaryKey ? "update" : "create";
        const forceFields = { [descriptor.foreignKey]: parentId };
        if (detailOperation === "update") forceFields[descriptor.primaryKey] = item[descriptor.primaryKey];
        const payload = await this.#validateDetailBody(descriptor, detailOperation, item, forceFields);
        const instance = await this.#upsertDetail(descriptor.target, payload, { transaction });
        saved.push(instance);
        savedForDetail.push(instance);
      }

      if (operation === "update" && descriptor.removeMissing) {
        await this.#removeMissingDetails(descriptor, parentId, savedForDetail, transaction);
      }
    }

    return saved;
  }

  async #removeMissingDetails(descriptor, parentId, savedDetails, transaction) {
    const ids = savedDetails
      .map((item) => item.getDataValue(descriptor.primaryKey))
      .filter((value) => value !== undefined && value !== null);
    const where = { [descriptor.foreignKey]: parentId };
    if (ids.length > 0) where[descriptor.primaryKey] = { [Op.notIn]: ids };
    await descriptor.target.destroy({ where, ...(transaction && { transaction }) });
  }

  async #mutateDetail({ params = {}, transaction, detailIdRequired = false }, callback) {
    const detailName = params.detail || params.detailName || params.details;
    const parentId = params.id;
    const detailId = params.detailId || params.childId;
    if (!detailName) throw new ValidationError("Detalle requerido", { errors: { detail: "Requerido" } });
    if (parentId === undefined || parentId === null) throw new ValidationError("ID del maestro requerido", { errors: { id: "Requerido" } });
    if (detailIdRequired && (detailId === undefined || detailId === null)) throw new ValidationError("ID del detalle requerido", { errors: { detailId: "Requerido" } });

    const descriptor = this.#detailDescriptor(detailName);

    return this.#withTransaction(transaction, async (activeTransaction) => {
      const parent = await this.#model.findByPk(parentId, { ...(activeTransaction && { transaction: activeTransaction }) });
      if (!parent) throw new NotFoundError(this.#resourceName());
      try {
        return await callback({ descriptor, parent, parentId, detailId, activeTransaction });
      } catch (error) {
        throw this.#normalizePersistenceError(error);
      }
    });
  }

  async #assertDetailBelongsToParent(descriptor, parentId, detailId, transaction) {
    const instance = await descriptor.target.findOne({
      where: { [descriptor.primaryKey]: detailId, [descriptor.foreignKey]: parentId },
      ...(transaction && { transaction }),
    });
    if (!instance) throw new NotFoundError(descriptor.name);
    return instance;
  }

  async #upsertDetail(model, payload, options = {}) {
    const primaryKey = model.primaryKeyAttribute || "id";
    if (payload[primaryKey] === undefined || payload[primaryKey] === null) return model.create(payload, options);

    const instance = await model.findByPk(payload[primaryKey], options);
    if (instance) return instance.update(payload, options);

    if (typeof model.upsert === "function") {
      const result = await model.upsert(payload, { ...options, where: { [primaryKey]: payload[primaryKey] } });
      return Array.isArray(result) ? result[0] : result;
    }

    return model.create(payload, options);
  }

  async #toJsonWithDetails(instance, transaction) {
    const descriptors = this.#detailDescriptors();
    if (descriptors.length === 0) return instance.toJSON();

    const primaryKey = this.#primaryKeyAttribute();
    const id = instance.getDataValue(primaryKey);
    const fresh = await this.#model.findByPk(id, {
      include: descriptors.map((descriptor) => ({ model: descriptor.target, as: descriptor.as })),
      ...(transaction && { transaction }),
    });
    return this.#plainModel(fresh || instance);
  }

  #plainModel(value) {
    if (Array.isArray(value)) return value.map((item) => this.#plainModel(item));
    if (value instanceof Date) return value;
    if (!value || typeof value !== "object") return value;
    if (value.dataValues && typeof value.dataValues === "object") return this.#plainModel(value.dataValues);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.#plainModel(item)]));
  }

  #detailDescriptors() {
    return Object.keys(this.#detailsConfig()).map((name) => this.#detailDescriptor(name));
  }

  #detailDescriptor(name) {
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
      removeMissing: config?.removeMissing === true,
    };
  }

  #association(name) {
    if (this.#model?.associations?.[name]) return this.#model.associations[name];
    return [...new Set(Object.values(this.#model?.associations || {}))].find((association) => association?.as === name) || null;
  }

  #detailsConfig() {
    if (!this.#config.details || typeof this.#config.details !== "object" || Array.isArray(this.#config.details)) return {};
    return this.#config.details;
  }

  #toJsonSchema(schema, operation) {
    if (!schema) return {};
    if (typeof schema.toJsonSchema !== "function") return {};
    return this.#enrichJsonSchema(normalizeJsonSchema(schema.toJsonSchema()), operation);
  }

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

  #resourceName() {
    if (typeof this.#config.resourceName === "string") return this.#config.resourceName;
    if (typeof this.#config.title === "string") return this.#config.title;
    if (typeof this.#config.resource === "string") return this.#config.resource;
    return this.#model?.modelName || this.#config.name || "Recurso";
  }

  async #validateBody(operation, body = {}) {
    return this.#validatePayload({
      operation,
      body,
      schemas: this.#schemas,
      definitions: this.#filterDefinitions(),
    });
  }

  async #validateDetailBody(descriptor, operation, body = {}, forceFields = {}) {
    return this.#validatePayload({
      operation,
      body,
      forceFields,
      schemas: descriptor.target?.resourceSchemas || {},
      definitions: descriptor.target?.resourceDefinition?.attributes || descriptor.target?.rawAttributes || {},
    });
  }

  async #validatePayload({ operation, body = {}, forceFields = {}, schemas = {}, definitions = {} }) {
    const schema = schemas[operation] || schemas.body;
    const rawPayload = { ...(body || {}), ...forceFields };
    const payload = this.#sanitizeBody(operation, rawPayload, definitions);
    const validationPayload = this.#validationPayload(schema, payload, forceFields);
    if (!schema) return payload;
    this.#validateBodyFields(schema, validationPayload);

    try {
      const validated = await schema.validate(validationPayload);
      return { ...validated, ...forceFields };
    } catch (error) {
      throw new ValidationError(error.message, {errors: error.errors || null, cause: error,});
    }
  }

  #validationPayload(schema, payload, forceFields) {
    if (!schema?.shapeDefinition || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
    let validationPayload = payload;
    for (const key of Object.keys(forceFields || {})) {
      if (key in schema.shapeDefinition) continue;
      if (validationPayload === payload) validationPayload = { ...payload };
      delete validationPayload[key];
    }
    return validationPayload;
  }

  #sanitizeBody(operation, body, definitions = this.#filterDefinitions()) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;
    let payload = body;

    for (const [field, definition] of Object.entries(definitions)) {
      if (!(field in body)) continue;
      if (!this.#shouldOmitBodyField(operation, definition)) continue;
      if (payload === body) payload = { ...body };
      delete payload[field];
    }

    return payload;
  }

  #shouldOmitBodyField(operation, definition) {
    if (operation === "create") {
      if (definition?.create === false) return true;
      return definition?.primaryKey && definition.autoIncrement;
    }
    if (operation !== "update") return false;
    if (definition?.update === false) return true;
    return definition?.primaryKey && definition.update !== true;
  }

  #updatesPrimaryKey(instance, data) {
    const pk = this.#primaryKeyAttribute();
    if (!pk || !data || typeof data !== "object" || !(pk in data)) return false;
    return data[pk] !== instance.getDataValue(pk);
  }

  #validateBodyFields(schema, body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    if (!schema.shapeDefinition || typeof schema.shapeDefinition !== "object") return;

    const allowed = new Set(Object.keys(schema.shapeDefinition));
    const errors = {};

    for (const field of Object.keys(body)) {
      if (!allowed.has(field)) errors[field] = "Campo no permitido";
    }

    if (Object.keys(errors).length > 0) {
      const fields = Object.keys(errors).join(", ");
      throw new ValidationError(`Datos inválidos, campo ${fields} no permitido`, { errors });
    }
  }

  #normalizePersistenceError(error) {
    const uniqueError = this.#uniqueConstraintError(error);
    if (uniqueError) return uniqueError;

    const details = error?.details;
    if (error?.name === "ValidationError" && details?.field) {
      return new ValidationError(error.message, {
        errors: { [details.field]: error.message },
        cause: error,
      });
    }

    if (error?.name === "ValidationError" && Array.isArray(details?.columns)) {
      return new ValidationError(error.message, {
        errors: Object.fromEntries(details.columns.map((column) => [this.#attributeName(column), error.message])),
        cause: error,
      });
    }

    return error;
  }

  #uniqueConstraintError(error) {
    const fields = this.#uniqueErrorFields(error);
    if (fields.length === 0) return null;

    return new ValidationError("Valor duplicado", {
      errors: Object.fromEntries(fields.map((field) => [field, "Ya existe un registro con este valor"])),
      cause: error,
    });
  }

  #uniqueErrorFields(error) {
    const details = error?.details;
    if (Array.isArray(details?.columns) && details.columns.length > 0) {
      return details.columns.map((column) => this.#attributeName(column));
    }

    const message = error?.message || "";
    if (!this.#isUniqueConstraintError(error, message)) return [];

    const sqliteColumns = message.match(/UNIQUE constraint failed:\s*(.+)$/i)?.[1];
    if (!sqliteColumns) return [];

    return sqliteColumns
      .split(",")
      .map((column) => column.trim().split(".").pop())
      .filter(Boolean)
      .map((column) => this.#attributeName(column));
  }

  #isUniqueConstraintError(error, message) {
    if (error?.code === "SEQ_VALIDATION_UNIQUE") return true;
    if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    if (error?.code === "SQLITE_CONSTRAINT" && /UNIQUE constraint failed/i.test(message)) return true;
    return /Duplicate value for unique constraint|UNIQUE constraint failed/i.test(message);
  }

  #attributeName(columnName) {
    const definitions = this.#filterDefinitions();
    for (const [attribute, definition] of Object.entries(definitions)) {
      if ((definition?.field || attribute) === columnName) return attribute;
    }
    return columnName;
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

  #buildWhere(query) {
    if (!query) return {};
    const where = {};
    const andFilters = [];
    const whitelist = this.#config.filterWhitelist || [];
    const definitions = this.#filterDefinitions();

    for (const [key, value] of Object.entries(query)) {
      if (key === "page" || key === "limit") continue;
      const filters = this.#queryFilters(key, value);

      for (const filter of filters) {
        if (whitelist.length > 0 && !whitelist.includes(filter.field)) continue;

        const definition = definitions[filter.field];
        if (!definition && Object.keys(definitions).length > 0) {
          throw new ValidationError(`Filtro "${filter.field}" no está permitido`);
        }

        const parsedValue = this.#parseFilterValue(filter.field, filter.operator, filter.value, definition);
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

  #queryFilters(key, value) {
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
  }

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

  #parseFilterValue(field, operator, value, definition) {
    if (operator === Op.in) {
      const values = this.#splitFilterValues(value);
      if (values.length === 0) throw new ValidationError(`Filtro "${field}" in requiere al menos un valor`);
      return values.map((item) => this.#castFilterValue(field, item, definition));
    }

    if (operator === Op.between) {
      const values = this.#splitFilterValues(value);
      if (values.length !== 2) throw new ValidationError(`Filtro "${field}" between requiere dos valores`);
      this.#assertRangeOperator(field, operator, definition);
      return values.map((item) => this.#castFilterValue(field, item, definition));
    }

    this.#assertRangeOperator(field, operator, definition);
    return this.#castFilterValue(field, value, definition);
  }

  #splitFilterValues(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return value.split(",").map((item) => item.trim());
    return [value];
  }

  #assertRangeOperator(field, operator, definition) {
    if (!RANGE_OPERATORS.has(operator) || !definition) return;
    const type = this.#filterType(definition);
    const isComparable = ["integer", "decimal", "number", "date", "string"].includes(type);
    if (!isComparable) {
      const operatorName = FILTER_OPERATOR_NAMES.get(operator) || "filtro";
      throw new ValidationError(`Filtro "${field}" no soporta operador "${operatorName}"`);
    }
  }

  #castFilterValue(field, value, definition) {
    const type = this.#filterType(definition);

    if (value === "" || value === undefined) throw new ValidationError(`Filtro "${field}" tiene un valor inválido`);
    if (!definition) return value;
    if (value === null) return null;

    if (type === "integer") {
      const number = Number(value);
      if (!Number.isInteger(number)) throw new ValidationError(`Filtro "${field}" debe ser integer`);
      return number;
    }

    if (type === "decimal" || type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new ValidationError(`Filtro "${field}" debe ser number`);
      return number;
    }

    if (type === "boolean") {
      if (value === true || value === false) return value;
      const normalized = String(value).toLowerCase();
      if (["true", "1", "yes", "si", "sí"].includes(normalized)) return true;
      if (["false", "0", "no"].includes(normalized)) return false;
      throw new ValidationError(`Filtro "${field}" debe ser boolean`);
    }

    if (type === "date") {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) throw new ValidationError(`Filtro "${field}" debe ser date`);
      return date;
    }

    return value;
  }

  #filterDefinitions() {
    return this.#config.resource?.definition || this.#model?.resourceDefinition?.attributes || {};
  }

  #primaryKeyAttribute() {
    const definitions = this.#filterDefinitions();
    return Object.entries(definitions).find(([, definition]) => definition?.primaryKey)?.[0] || "id";
  }

  #filterType(definition) {
    const type = definition?.type;
    const typeName = typeof type === "string" ? type : type?.key || type?.constructor?.name || "";
    const normalized = typeName.toLowerCase();

    if (normalized.includes("integer") || normalized === "int") return "integer";
    if (normalized.includes("decimal")) return "decimal";
    if (normalized.includes("number")) return "number";
    if (normalized.includes("boolean") || normalized === "bool") return "boolean";
    if (normalized.includes("date")) return "date";
    if (normalized.includes("string")) return "string";
    if (normalized.includes("object") || normalized.includes("json")) return "object";
    return "unknown";
  }
}
