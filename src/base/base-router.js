import express from "express";
import { ok, list } from "../http/response.js";
import { getContext } from "../context/request-context.js";
import { AppError } from "../errors/app-error.js";

export class BaseRouter {
  #service;
  #config;
  #routeRegistry;
  #expressRouter;

  constructor({ service, config, routeRegistry }) {
    this.#service = service;
    this.#config = config;
    this.#routeRegistry = routeRegistry;
    this.#expressRouter = express.Router();
  }

  get service() {
    return this.#service;
  }

  get config() {
    return this.#config;
  }

  get router() {
    return this.#expressRouter;
  }

  build() {
    const endpoints = this.#config.endpoints || {};

    for (const [op, endpoint] of Object.entries(endpoints)) {
      if (!endpoint.enabled) {
        if (op === "schema") this.disabledRoute(endpoint.method || "get", endpoint.path || "/schema", "SCHEMA_DISABLED", "Schema disabled");
        continue;
      }

      const method = endpoint.method || "get";
      const path = endpoint.path || "/";
      const serviceMethod = op;

      this.route(method, path, {
        service: serviceMethod,
        permission: endpoint.permission,
        summary: endpoint.summary,
        description: endpoint.description,
        tags: endpoint.tags || this.#config.tags,
      });
    }

    this.registerCustomRoutes();
  }

  registerCustomRoutes() {}

  disabledRoute(method, path, code, message) {
    this.#expressRouter[method](path, async (_req, _res, next) => {
      next(new AppError(message, { status: 404, code }));
    });
  }

  route(method, path, options = {}) {
    const { service: serviceMethod, permission, summary, description, tags } = options;

    const expressPath = path;
    const openApiPath = path.replace(/:([^/]+)/g, "{$1}");

    const descriptor = {
      module: this.#config.name,
      operationId: `${this.#config.name}.${serviceMethod}`,
      method,
      expressPath: `${this.#config.basePath}${expressPath}`,
      openApiPath: `${this.#config.basePath}${openApiPath}`,
      serviceMethod,
      auth: this.#config.auth,
      permissions: permission ? [permission] : [],
      summary: summary || "",
      description: description || "",
      tags: tags || [],
      deprecated: false,
    };

    this.#routeRegistry.register(descriptor);

    this.#expressRouter[method](expressPath, async (req, res, next) => {
      try {
        const context = getContext();
        const args = { params: req.params, query: req.query, body: req.body, context, transaction: null};

        const result = await this.#service[serviceMethod](args);
        if (result.pagination)  return res.json(list(result.data, result.pagination));
        return res.json(ok(result.data));
      } catch (err) {
        next(err);
      }
    });
  }
}

