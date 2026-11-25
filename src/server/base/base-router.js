import express from "express";
import { ok, list, lastUpdateAt } from "../http/response.js";
import { getContext } from "../context/request-context.js";
import { AppError } from "../errors/app-error.js";
import { renderImportPage, importStylesheet } from "../import/page.js";
import { importBrowser } from "../import/browser.js";

export class BaseRouter {
  #service;
  #config;
  #routeRegistry;
  #expressRouter;

  constructor({ service, config, routeRegistry, authorize }) {
    this.#service = service;
    this.#config = config;
    this.#routeRegistry = routeRegistry;
    this.authorize = authorize;
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
    const endpoints = Object.entries(this.#config.endpoints || {}).sort(([, left], [, right]) => endpointSpecificity(right) - endpointSpecificity(left));
    for (const [op, endpoint] of endpoints) {
      if (!endpoint.enabled) {
        if (op === "schema") this.disabledRoute(endpoint.method || "get", endpoint.path || "/schema", "SCHEMA_DISABLED", "Schema disabled");
        continue;
      }
      const method = endpoint.method || "get";
      const path = endpoint.path || "/";
      const serviceMethod = op;
      this.route(method, path, {service: serviceMethod,permission: endpoint.permission, auth: endpoint.auth, summary: endpoint.summary, description: endpoint.description, tags: endpoint.tags || this.#config.tags});
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
    const { service: serviceMethod, permission, auth, summary, description, tags } = options;

    const expressPath = path;
    const openApiPath = path.replace(/:([^/]+)/g, "{$1}");

    const descriptor = {
      module: this.#config.name,
      operationId: `${this.#config.name}.${serviceMethod}`,
      method,
      expressPath: `${this.#config.basePath}${expressPath}`,
      openApiPath: `${this.#config.basePath}${openApiPath}`,
      serviceMethod,
      auth: auth || this.#config.auth,
      permissions: permission ? [permission] : [],
      summary: summary || "",
      description: description || "",
      tags: tags || [],
      deprecated: false,
    };

    this.#routeRegistry.register(descriptor);

    const handlers = [];
    if (this.authorize) handlers.push(this.authorize({ auth: auth || this.#config.auth, permissions: permission ? [permission] : [] }));
    if (serviceMethod === "import") handlers.push(express.text({ type: ["text/csv", "application/csv"], limit: "1mb" }));

    handlers.push(async (req, res, next) => {
      try {
        const {params, query, body} = req;
        const args = { params, query, body};

        if (serviceMethod === "importPage") {
          res.set("Cache-Control", "no-store");
          if (query.asset === "script") return res.type("js").send(`(${importBrowser.toString()})();`);
          if (query.asset === "style") return res.type("css").send(importStylesheet);
          return res.type("html").send(renderImportPage(this.#config));
        }

        const timestamp = serviceMethod === "list" ? lastUpdateAt() : null;
        const result = await this.#service[serviceMethod](args);
        if (serviceMethod === "import") return res.json(result);
        if (serviceMethod === "export" || serviceMethod === "importTemplate") {
          res.append("Access-Control-Expose-Headers", "Content-Disposition");
          return res.attachment(result.filename).type(result.contentType).send(result.body);
        }
        const response = result.pagination ? list(result.data, result.pagination) : ok(result.data);
        if (timestamp) response.lastUpdateAt = timestamp;
        return res.json(response);
      } catch (err) {
        next(err);
      }
    });

    this.#expressRouter[method](expressPath, ...handlers);
  }
}

function endpointSpecificity(endpoint = {}) {
  return String(endpoint.path || "/")
    .split("/")
    .filter(Boolean)
    .reduce((score, segment) => score + (segment.startsWith(":") ? 1 : 10), 0);
}

