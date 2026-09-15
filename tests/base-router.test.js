import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import express from "express";

import { BaseRouter } from "../src/server/base/base-router.js";

let server;
let baseUrl;

before(async () => {
  const router = new BaseRouter({
    config: {
      name: "items",
      basePath: "/items",
      auth: { required: false },
      endpoints: {
        list: { enabled: true, method: "get", path: "/" },
        get: { enabled: true, method: "get", path: "/:id" },
        pending: { enabled: true, method: "get", path: "/pending" },
        document: { enabled: true, method: "get", path: "/documents/:type" },
      },
    },
    routeRegistry: { register() {} },
    service: {
      async list() { return { data: "list" }; },
      async get({ params }) { return { data: `get:${params.id}` }; },
      async pending() { return { data: "pending" }; },
      async document({ params }) { return { data: `document:${params.type}` }; },
    },
  });
  router.build();
  const app = express();
  app.use(router.router);
  server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

it("registers specific routes before generic parameter routes", async () => {
  const pending = await request("/pending");
  const document = await request("/documents/01");
  const item = await request("/123");

  assert.equal(pending.data, "pending");
  assert.equal(document.data, "document:01");
  assert.equal(item.data, "get:123");
});

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return response.json();
}
