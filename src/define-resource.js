import yep from "yep";
import { Model, DataTypes } from "seq";

const MODEL_OPTION_KEYS = new Set([ "modelName", "tableName", "timestamps", "createdAt", "updatedAt", "alias", "hooks"]);
const ATTRIBUTE_OPTION_KEYS = new Set(["type", "primaryKey", "autoIncrement", "allowNull", "defaultValue", "unique", "field", "references", "get", "set"]);
const STRING_TYPE_NORMALIZERS = {
  integer: () => DataTypes.INTEGER,
  int: () => DataTypes.INTEGER,
  string: (definition) => DataTypes.STRING(definition.maxLength),
  decimal: (definition) => DataTypes.DECIMAL(numberPrecision(definition), numberScale(definition)),
  number: (definition) => DataTypes.NUMBER(numberPrecision(definition), numberScale(definition)),
  boolean: () => DataTypes.BOOLEAN,
  bool: () => DataTypes.BOOLEAN,
  date: () => DataTypes.DATE,
  object: () => DataTypes.OBJECT,
  json: () => DataTypes.JSON,
  array: (definition) => DataTypes.ARRAY(normalizeNestedDataType(definition.itemType ?? definition.items ?? definition.of)),
  virtual: (definition) => DataTypes.VIRTUAL(normalizeNestedDataType(definition.returnType), definition.fields),
};

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
  if (isSeqDataTypeFactory(definition.type)) return definition.type._defaultType();
  if (isSeqDataType(definition.type)) return definition.type;
  if (typeof definition.type !== "string") throw new Error(`Attribute "${name}" type must be a string or seq DataType`);

  const type = normalizeTypeName(definition.type);
  const normalize = STRING_TYPE_NORMALIZERS[type];
  if (normalize) return normalize(definition);
  throw new Error(`Attribute "${name}" type "${definition.type}" is not supported`);
}

function normalizeNestedDataType(type) {
  if (type === undefined || type === null) return undefined;
  if (isSeqDataTypeFactory(type)) return type._defaultType();
  if (isSeqDataType(type)) return type;
  if (typeof type === "string") {
    const normalize = STRING_TYPE_NORMALIZERS[normalizeTypeName(type)];
    if (normalize) return normalize({ type });
  }
  return type;
}

function normalizeTypeName(type) {
  return type.trim().toLowerCase();
}

function isSeqDataTypeFactory(type) {
  return typeof type === "function" && typeof type._defaultType === "function";
}

function isSeqDataType(type) {
  return type && typeof type === "object" && typeof type.key === "string" && typeof type.validate === "function";
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
  if (isVirtualDataType(definition.type)) return false;
  if (definition.schema === false) return false;
  if (operation === "create" && definition.create === false) return false;
  if (operation === "update" && definition.update === false) return false;
  if (definition.primaryKey && definition.autoIncrement) return false;
  return true;
}

function isVirtualDataType(type) {
  return type?.key === "VIRTUAL" || type?.constructor?.name === "VirtualType";
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
