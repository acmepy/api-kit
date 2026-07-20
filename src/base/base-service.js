import { NotFoundError } from "../errors/not-found-error.js";
import { ValidationError } from "../errors/validation-error.js";
import { Op } from "seq";

const FILTER_OPERATORS = {
  eq: Op.eq,
  equal: Op.eq,
  igual: Op.eq,
  gt: Op.gt,
  greater: Op.gt,
  mayor: Op.gt,
  gte: Op.gte,
  greaterOrEqual: Op.gte,
  mayorIgual: Op.gte,
  lt: Op.lt,
  less: Op.lt,
  menor: Op.lt,
  lte: Op.lte,
  lessOrEqual: Op.lte,
  menorIgual: Op.lte,
  in: Op.in,
  incluido: Op.in,
  between: Op.between,
};

const FILTER_OPERATOR_NAMES = new Map(Object.entries(FILTER_OPERATORS).map(([name, op]) => [op, name]));
const RANGE_OPERATORS = new Set([Op.gt, Op.gte, Op.lt, Op.lte, Op.between]);

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
    const data = await this.#validateBody("create", body);
    try {
      const instance = await this.#model.create(data, { ...(transaction && { transaction })});
      return { data: instance.toJSON() };
    } catch (error) {
      throw this.#normalizePersistenceError(error);
    }
  }

  async update({ params, query, body, context, transaction } = {}) {
    const instance = await this.#model.findByPk(params.id, { ...(transaction && { transaction }),});
    if (!instance)  throw new NotFoundError(this.#resourceName());
    const data = await this.#validateBody("update", body);
    const auditOld = instance.toJSON();
    try {
      await instance.update(data, { auditOld, ...(transaction && { transaction }) });
      return { data: instance.toJSON() };
    } catch (error) {
      throw this.#normalizePersistenceError(error);
    }
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
    this.#validateBodyFields(schema, body || {});

    try {
      return await schema.validate(body || {});
    } catch (error) {
      throw new ValidationError(error.message, {
        errors: error.errors || null,
        cause: error,
      });
    }
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
      return Object.entries(value).map(([operatorName, operatorValue]) => {
        const operator = FILTER_OPERATORS[operatorName];
        if (!operator) throw new ValidationError(`Operador de filtro "${operatorName}" no está soportado`);
        return { field: key, operator, value: operatorValue };
      });
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
    return this.#config.resource?.definition || this.#model?.resourceDefinition?.attributes || this.#model?.rawAttributes || {};
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





