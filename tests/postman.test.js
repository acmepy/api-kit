import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPostmanCollection } from "../src/server/schema/postman-builder.js";
import { RouteRegistry } from "../src/server/schema/route-registry.js";

describe("Postman collection", () => {
  it("groups login session and logout routes inside a single session folder", () => {
    const routes = new RouteRegistry();
    routes.register({ module: "auth", operationId: "auth.login", method: "post", expressPath: "/api/login", openApiPath: "/api/login", serviceMethod: "login", auth: { required: false, strategies: [] }, permissions: [], summary: "Login", description: "", tags: ["auth"], deprecated: false });
    routes.register({ module: "auth", operationId: "auth.session", method: "get", expressPath: "/api/session", openApiPath: "/api/session", serviceMethod: "session", auth: { required: true, strategies: ["bearer", "basic"] }, permissions: [], summary: "Session", description: "", tags: ["auth"], deprecated: false });
    routes.register({ module: "auth", operationId: "auth.logout", method: "post", expressPath: "/api/logout", openApiPath: "/api/logout", serviceMethod: "logout", auth: { required: true, strategies: ["bearer", "basic"] }, permissions: [], summary: "Logout", description: "", tags: ["auth"], deprecated: false });

    const collection = buildPostmanCollection({ routes, config: { basePath: "/api" } });
    const root = collection.item.find((item) => item.name === "api");
    const session = root.item.find((item) => item.name === "session");

    assert.ok(session);
    assert.deepEqual(session.item.map((item) => item.name), ["Login", "Session", "Logout"]);
    assert.equal(root.item.find((item) => item.name === "login"), undefined);
    assert.equal(root.item.find((item) => item.name === "logout"), undefined);
  });

  it("groups audit resource routes inside a single audit folder", () => {
    const routes = new RouteRegistry();
    routes.register({ module: "audit", operationId: "audit.list", method: "get", expressPath: "/api/audit", openApiPath: "/api/audit", serviceMethod: "list", auth: { required: false, strategies: [] }, permissions: [], summary: "Listar", description: "", tags: ["audit"], deprecated: false });
    routes.register({ module: "audit", operationId: "audit.get", method: "get", expressPath: "/api/audit/:id", openApiPath: "/api/audit/{id}", serviceMethod: "get", auth: { required: false, strategies: [] }, permissions: [], summary: "Obtener por ID", description: "", tags: ["audit"], deprecated: false });

    const collection = buildPostmanCollection({ routes, config: { basePath: "/api" } });
    const root = collection.item.find((item) => item.name === "api");
    const audit = root.item.find((item) => item.name === "audit");

    assert.ok(audit);
    assert.deepEqual(audit.item.map((item) => item.name), ["Listar", "Obtener por ID"]);
    assert.equal(root.item.find((item) => item.name === "list"), undefined);
    assert.equal(root.item.find((item) => item.name === "get"), undefined);
  });
});
