import { AsyncLocalStorage } from "node:async_hooks";
import { tenantValues, tenantAttribute } from "../context/tenant-context.js";

const validationContext = Symbol("api-kit nested schema validation");
const configuredModels = new WeakSet();
const validationTransactions = new AsyncLocalStorage();

export function validateResourceSchema(schema, values, transaction, model) {
  return validationTransactions.run(transaction, () => schema.validate(tenantValues(model, values)));
}

export function schemaValidationTransaction() {
  return validationTransactions.getStore();
}

async function validateNestedCreate(values, options) {
  const context = options[validationContext];
  if (!context) return;
  if (this === context.root && !context.rootVisited) {
    context.rootVisited = true;
    return;
  }
  const validated = await validateResourceSchema(this.resourceSchemas.create, values, options.transaction, this);
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(validated, key) && !context.foreignKeys.get(this)?.has(key) && key !== tenantAttribute(this)) delete values[key];
  }
  Object.assign(values, validated);
}

export function nestedSchemaValidationOptions(root, includes, foreignKeys = new Map()) {
  for (const include of includes) {
    const target = include.model;
    if (!foreignKeys.has(target)) foreignKeys.set(target, new Set());
    for (const key of [include.foreignKey].flat()) foreignKeys.get(target).add(key);
    if (target.resourceSchemas?.create && !configuredModels.has(target)) {
      target.addHook("beforeCreate", validateNestedCreate);
      configuredModels.add(target);
    }
    if (include.include) nestedSchemaValidationOptions(root, include.include, foreignKeys);
  }
  return { [validationContext]: { root, rootVisited: false, foreignKeys } };
}
