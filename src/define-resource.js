import yep from "yep";
import { Model, DataTypes } from "seq";

const MODEL_OPTION_KEYS = new Set([ "modelName", "tableName", "timestamps", "createdAt", "updatedAt", "alias", "hooks"]);
const ATTRIBUTE_OPTION_KEYS = new Set(["type", "primaryKey", "autoIncrement", "allowNull", "defaultValue", "unique", "field", "references"]);

export function defineResource(definition = {}) {
  const { attributes = {}, schemas = {}, model: CustomModel = null } = definition;
  const modelOptions = pickModelOptions(definition);
  const normalizedAttributes = normalizeAttributes(attributes);
  const modelAttributes = buildModelAttributes(normalizedAttributes);
  const generatedSchemas = buildSchemas(normalizedAttributes, schemas);
  const ResourceModel = CustomModel || class extends Model {
    static define(seq) {
      return this.init(modelAttributes, { ...modelOptions, seq });
    }
  };

  ResourceModel.attributes = modelAttributes;
  ResourceModel.resourceSchemas = generatedSchemas;
  ResourceModel.resourceDefinition = definition;

  return { model: ResourceModel, schemas: generatedSchemas, attributes: modelAttributes, definition: normalizedAttributes, options: modelOptions};
}

function pickModelOptions(definition) {
  const options = {};
  for (const key of MODEL_OPTION_KEYS)  if (definition[key] !== undefined) options[key] = definition[key];
  return options;
}

function normalizeAttributes(attributes) {
  const normalized = {};

  for (const [name, definition] of Object.entries(attributes)) {
    normalized[name] = { ...definition, type: normalizeDataType(definition, name)};
  }

  return normalized;
}

function normalizeDataType(definition, name) {
  if (typeof definition.type !== "string") throw new Error(`Attribute "${name}" type must be a string`);
  const type = definition.type.toLowerCase();
  if (type === "integer" || type === "int") return DataTypes.INTEGER;
  if (type === "string") return DataTypes.STRING(definition.maxLength);
  if (type === "decimal") return DataTypes.DECIMAL(numberPrecision(definition), numberScale(definition));
  if (type === "number") return DataTypes.NUMBER(numberPrecision(definition), numberScale(definition));
  if (type === "boolean" || type === "bool") return DataTypes.BOOLEAN;
  if (type === "date") return DataTypes.DATE;
  if (type === "object") return DataTypes.OBJECT;
  if (type === "json") return DataTypes.JSON;
  throw new Error(`Attribute "${name}" type "${definition.type}" is not supported`);
}

function numberPrecision(definition) {
  return definition.precision;
}

function numberScale(definition) {
  return definition.scale;
}

function buildModelAttributes(attributes) {
  const modelAttributes = {};
  for (const [name, definition] of Object.entries(attributes)) {
    const attribute = {};
    for (const key of ATTRIBUTE_OPTION_KEYS)  if (definition[key] !== undefined) attribute[key] = definition[key];
    modelAttributes[name] = attribute;
  }
  return modelAttributes;
}

function buildSchemas(attributes, explicitSchemas) {
  return {
    create: explicitSchemas.create || yep.object(buildShape(attributes, "create")),
    update: explicitSchemas.update || yep.object(buildShape(attributes, "update")),
    ...explicitSchemas,
  };
}

function buildShape(attributes, operation) {
  const shape = {};
  for (const [name, definition] of Object.entries(attributes)) {
    if (!shouldIncludeInSchema(definition, operation)) continue;
    const schema = resolveValidation(definition, operation);
    if (schema) shape[name] = schema;
  }
  return shape;
}

function shouldIncludeInSchema(definition, operation) {
  if (definition.schema === false) return false;
  if (operation === "create" && definition.create === false) return false;
  if (operation === "update" && definition.update === false) return false;
  if (definition.primaryKey && definition.autoIncrement) return false;
  return true;
}

function resolveValidation(definition, operation) {
  const schema = applyDeclarativeRules(inferValidation(definition), definition);
  if (!schema || typeof schema.validate !== "function") return null;
  if (operation === "create" && definition.allowNull === false && typeof schema.required === "function") schema.required();
  if (definition.allowNull === true && typeof schema.nullable === "function") schema.nullable();
  if (operation === "create" && definition.defaultValue !== undefined && typeof schema.default === "function") schema.default(definition.defaultValue);
  return schema;
}

function applyDeclarativeRules(schema, definition) {
  if (!schema) return schema;
  if (definition.title && typeof schema.title === "function") schema.title(definition.title);
  if (definition.min !== undefined && typeof schema.min === "function") schema.min(definition.min);
  if (definition.max !== undefined && typeof schema.max === "function") schema.max(definition.max);
  if (definition.oneOf && typeof schema.oneOf === "function") schema.oneOf(definition.oneOf);
  if (definition.notOneOf && typeof schema.notOneOf === "function") schema.notOneOf(definition.notOneOf);
  if (definition.regex && typeof schema.regex === "function") schema.regex(definition.regex);
  if (definition.matches && typeof schema.matches === "function") schema.matches(definition.matches);
  if (definition.email === true && typeof schema.email === "function") schema.email();
  return schema;
}

function inferValidation(definition) {
  const typeName = definition.type?.key || definition.type?.constructor?.name || "";
  const normalized = typeName.toLowerCase();
  if (normalized.includes("string")) return yep.string();
  if (normalized.includes("integer")) return yep.integer();
  if (normalized.includes("decimal") || normalized.includes("number")) return yep.number();
  if (normalized.includes("boolean")) return yep.boolean();
  if (normalized.includes("date")) return yep.date();
  if (normalized.includes("array")) return yep.array();
  if (normalized.includes("object") || normalized.includes("json")) return yep.objectType();
  return null;
}
