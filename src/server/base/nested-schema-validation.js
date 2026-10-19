import { AsyncLocalStorage } from "node:async_hooks";

const validationContext = Symbol("api-kit nested schema validation");
const configuredModels = new WeakSet();
const validationTransactions = new AsyncLocalStorage();

export function validateResourceSchema(schema, values, transaction) {
  return validationTransactions.run(transaction, () => schema.validate(values));
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
  const validated = await validateResourceSchema(this.resourceSchemas.create, values, options.transaction);
  Object.assign(values, validated);
}

export function nestedSchemaValidationOptions(root, includes) {
  for (const include of includes) {
    const target = include.model;
    if (target.resourceSchemas?.create && !configuredModels.has(target)) {
      target.addHook("beforeCreate", validateNestedCreate);
      configuredModels.add(target);
    }
    if (include.include) nestedSchemaValidationOptions(root, include.include);
  }
  return { [validationContext]: { root, rootVisited: false } };
}
