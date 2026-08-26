import { normalizeJsonSchema } from "../utils/normalize.js";

export function normalizeDocumentConfig(config, defaults = {}) {
  if (!config) return null;
  return { ...defaults, ...(config === true ? {} : config) };
}

export function routesForSession(routes, session) {
  if (session === undefined) return routes;
  const permissions = new Set(session?.permissions || []);

  return routes.filter((route) => {
    if (!route.auth?.required) return true;
    if (!session) return false;
    return (route.permissions || []).every((permission) => permissions.has(permission));
  });
}

export function routeRequestSchemaName(route) {
  if (route.serviceMethod === "create") return "create";
  if (route.serviceMethod === "update") return "update";
  return null;
}

export function jsonSchemaForRoute(modules, route, schemaName = route.serviceMethod) {
  const schema = modules.get(route.module)?.schemas?.[schemaName];
  if (!schema || typeof schema.toJsonSchema !== "function") return null;
  return normalizeJsonSchema(schema.toJsonSchema());
}
