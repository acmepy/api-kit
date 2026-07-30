import { ok } from "../http/response.js";
import { normalizeMountPath } from "../utils/normalize.js";

export function installWelcomeRoute({ mainRouter, routeRegistry, config, packageInfo }) {
  const fullPath = normalizeMountPath(config.basePath) || "/";
  const packageName = packageInfo.name || "api-kit";

  routeRegistry.register({ module: "system", operationId: "system.welcome", method: "get", expressPath: fullPath, openApiPath: fullPath, serviceMethod: "welcome", auth: { required: false, strategies: [] }, permissions: [], summary: "Backend welcome", description: "", tags: ["system"], deprecated: false });

  mainRouter.get(fullPath, (_req, res) => {res.json(ok({ name: packageName, message: `Bienvenido al backend de ${packageName}` }))});
}
