import express from "express";
import { RBAC } from "iam";
import { auth as iamAuth, can as iamCan } from "iam/express";
import { ConfigError } from "../errors/config-error.js";
import { getContext } from "../context/request-context.js";
import { joinPaths } from "../utils/paths.js";
import { normalizeMountPath, toIamStrategies } from "../utils/normalize.js";

export function installAuthRoutes({ mainRouter, routeRegistry, config, auth }) {
  if (!auth) return null;
  if (!auth.adapter) throw new ConfigError("auth.adapter es requerido cuando auth esta habilitado");
  const authContext = createAuthContext(config, auth);

  const loginPath = joinPaths(config.basePath, authContext.loginPath);
  const sessionPath = joinPaths(config.basePath, authContext.sessionPath);
  const logoutPath = joinPaths(config.basePath, authContext.logoutPath);

  routeRegistry.register({module: "auth", operationId: "auth.login", method: "post", expressPath: loginPath, openApiPath: loginPath, serviceMethod: "login", auth: { required: false, strategies: [] }, permissions: [], summary: "Login", description: "", tags: ["auth"], deprecated: false});
  routeRegistry.register({module: "auth", operationId: "auth.session", method: "get", expressPath: sessionPath, openApiPath: sessionPath, serviceMethod: "session", auth: { required: true, strategies: authContext.strategies }, permissions: [], summary: "Session", description: "", tags: ["auth"], deprecated: false});
  routeRegistry.register({module: "auth", operationId: "auth.logout", method: "post", expressPath: logoutPath, openApiPath: logoutPath, serviceMethod: "logout", auth: { required: true, strategies: authContext.strategies }, permissions: [], summary: "Logout", description: "", tags: ["auth"], deprecated: false});

  const basePath = normalizeMountPath(config.basePath) || "/";
  const authRouter = express.Router();
  authRouter.post(authContext.loginPath, authContext.middleware);
  authRouter.get(authContext.sessionPath, authContext.middleware);
  authRouter.post(authContext.logoutPath, authContext.middleware);
  mainRouter.use(basePath, authRouter);
  return authContext;
}

export function createAuthContext(config, authBackend) {
  const adapter = authBackend.adapter;
  const rbac = new RBAC({ adapter });
  const logging = authBackend.logging ?? config.logging;
  const authConfig = { ...authBackend, logging };
  const middleware = iamAuth(iamAuthOptions(authConfig, adapter));
  return { ...authConfig, adapter, rbac, middleware, models: adapter.models || authBackend.models || null, seq: config.seq};
}

export function createAuthorizer(resolveAuthContext) {
  return ({ auth = { required: false }, permissions = [] } = {}) => {
    if (!auth?.required) return (_req, _res, next) => next();
    return (req, res, next) => {
      const authContext = typeof resolveAuthContext === "function" ? resolveAuthContext() : resolveAuthContext;
      if (!authContext) return res.status(401).json({ ok: false, message: "Auth no configurado" });

      return composeMiddlewares([
        authContext.middleware,
        syncAuthContext,
        ...(permissions || []).filter(Boolean).map((permission) => iamCan(permission)),
        syncAuthContext,
      ])(req, res, next);
    };
  };
}

function setAuthContext(session) {
  const ctx = getContext();
  if (!ctx) return;
  ctx.user = session.user;
  ctx.session = session;
  ctx.audit = { ...(ctx.audit || {}), userId: session.user?.id || null };
}

function syncAuthContext(req, _res, next) {
  if (req.session) {
    req.user = req.session.user;
    setAuthContext(req.session);
  }
  next();
}

function composeMiddlewares(middlewares) {
  return (req, res, next) => {
    let index = 0;
    const run = (error) => {
      if (error) return next(error);
      const middleware = middlewares[index++];
      if (!middleware) return next();
      try {
        return Promise.resolve(middleware(req, res, run)).catch(next);
      } catch (err) {
        return next(err);
      }
    };
    return run();
  };
}

function iamAuthOptions(auth, adapter) {
  return {
    adapter,
    logging: auth.logging,
    jwt: {
      secret: auth.secret,
      expiresIn: auth.tokenExpiresIn,
    },
    strategies: toIamStrategies(auth.strategies || ["bearer", "basic"]),
    createSession: auth.createSession,
  };
}

