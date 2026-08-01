import express from "express";
import { RBAC } from "iam";
import { SeqAdapter } from "iam/adapters";
import { auth as iamAuth, can as iamCan } from "iam/express";
import { getContext } from "../context/request-context.js";
import { applyNamingConvention } from "../utils/naming.js";
import { joinPaths } from "../utils/paths.js";
import { normalizeMountPath, toIamStrategies } from "../utils/normalize.js";

export function installAuthRoutes({ mainRouter, routeRegistry, config, authContext }) {
  if (!authContext) return;

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
}

export function createAuthContext(config, authBackend, { auditWriter } = {}) {
  const adapter = authBackend.adapter || new SeqAdapter({ seq: config.seq, models: authBackend.models, auditable: authAuditable(config, authBackend, auditWriter) });
  const rbac = new RBAC({ adapter });
  const middleware = iamAuth(iamAuthOptions(authBackend, adapter));
  return { ...authBackend, adapter, rbac, middleware, models: adapter.models || authBackend.models || null, seq: config.seq};
}

export function createAuthorizer(authContext) {
  return ({ auth = { required: false }, permissions = [] } = {}) => {
    if (!auth?.required) return (_req, _res, next) => next();
    if (!authContext) return (_req, res) => res.status(401).json({ ok: false, message: "Auth no configurado" });

    const handlers = [
      iamAuth(iamAuthOptions({ ...authContext, ...auth }, authContext.adapter)),
      syncAuthContext,
      ...(permissions || []).filter(Boolean).map((permission) => iamCan(permission)),
      syncAuthContext,
    ];

    return composeMiddlewares(handlers);
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
    jwt: {
      secret: auth.secret,
      expiresIn: auth.tokenExpiresIn,
    },
    strategies: toIamStrategies(auth.strategies || ["bearer", "basic"]),
    createSession: auth.createSession,
  };
}

function authAuditable(config, authBackend, auditWriter) {
  if (!auditWriter || authBackend.auditable === false) return null;
  return {
    tableName: authBackend.tableNames?.Session || applyNamingConvention("Session", config.seq?.adapter?.naming),
    write: auditWriter,
  };
}
