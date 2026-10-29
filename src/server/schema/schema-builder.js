import { jsonSchemaForRoute, normalizeDocumentConfig, routesForSession } from "./document-utils.js";

export function normalizeSchemaDocumentConfig(schema) {
  return normalizeDocumentConfig(schema, { permission: "schema.list" });
}

export function buildSchemaDocument({ routes, modules, session } = {}) {
  const services = new Map();

  for (const route of routesForSession(routes.getAll(), session)) {
    const module = modules.get(route.module);
    if (!module) continue;

    if (!services.has(route.module)) services.set(route.module, {
      name: route.module,
      primaryKeyAttributes: module.model?.primaryKeyAttributes || ["id"],
      ...(module.model?.options.tenant && { tenant: module.model.options.tenant }),
      details: Object.fromEntries((module.model?.getAssociationIncludes?.() || [])
        .filter(({ as }) => Object.hasOwn(module.config?.details || {}, as))
        .map(({ as, model, foreignKey }) => [as, { foreignKey, primaryKeyAttributes: model.primaryKeyAttributes, ...(model.options.tenant && { tenant: model.options.tenant }) }])),
      operations: {},
      schemas: {},
    });

    const service = services.get(route.module);
    service.operations[route.serviceMethod] = {
      method: route.method.toUpperCase(),
      path: route.openApiPath,
      permissions: route.permissions || [],
    };

    const jsonSchema = jsonSchemaForRoute(modules, route);
    if (jsonSchema) service.schemas[route.serviceMethod] = jsonSchema;
  }

  return { schema: "1.0.0", services: [...services.values()] };
}
