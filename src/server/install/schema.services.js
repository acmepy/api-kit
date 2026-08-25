import { buildOpenApiDocument } from "../schema/openapi-builder.js";
import { buildPostmanCollection } from "../schema/postman-builder.js";
import { joinPaths } from "../utils/paths.js";

export function installOpenApiRoute({ mainRouter, routeRegistry, modules, packageInfo, config, openapi, authorize }) {
  if (!openapi) return;
  const fullPath = joinPaths(config.basePath, openapi.path || "/openapi.json");
  const auth = normalizeRouteAuth(openapi.auth);
  const permissions = openapi.permission ? [openapi.permission] : [];
  routeRegistry.register({ module: "openapi", operationId: "openapi.get", method: "get", expressPath: fullPath, openApiPath: fullPath, serviceMethod: "openapi", auth, permissions, summary: "OpenAPI document", description: "", tags: ["openapi"], deprecated: false});
  const handlers = [];
  if (authorize) handlers.push(authorize({ auth, permissions }));
  handlers.push((req, res) => {res.json(buildOpenApiDocument({ routes: routeRegistry, modules, packageInfo, config: openapi, session: req.session || null }))});
  mainRouter.get(fullPath, ...handlers);
}

export function installPostmanRoute({ mainRouter, routeRegistry, modules, packageInfo, config, postman, authorize }) {
  if (!postman) return;
  const fullPath = joinPaths(config.basePath, postman.path || "/postman.json");
  const auth = normalizeRouteAuth(postman.auth);
  const permissions = postman.permission ? [postman.permission] : [];
  routeRegistry.register({ module: "openapi", operationId: "postman.get", method: "get", expressPath: fullPath, openApiPath: fullPath, serviceMethod: "postman", auth, permissions, summary: "Postman collection", description: "", tags: ["postman"], deprecated: false});
  const handlers = [];
  if (authorize) handlers.push(authorize({ auth, permissions }));
  handlers.push((_req, res) => {res.json(buildPostmanCollection({ routes: routeRegistry, modules, packageInfo, config: { ...postman, basePath: config.basePath } }))});
  mainRouter.get(fullPath, ...handlers);
}

export function normalizeRouteAuth(auth) {
  if (!auth) return { required: false, strategies: [] };
  if (auth === true) return { required: true, strategies: ["bearer", "basic"] };
  const strategies = auth.strategies || auth.strategy || ["bearer", "basic"];
  return { ...auth, required: auth.required ?? true, strategies: Array.isArray(strategies) ? strategies : [strategies] };
}
