import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApiClient, BaseService, SchemaService, SessionService } from "../src/client/index.js";

describe("client public API", () => {
  it("builds urls from the configured base url and query params", () => {
    const client = createApiClient({
      url: "http://server/api",
      fetch: async () => jsonResponse({ ok: true }),
      pingInterval: 60_000,
    });

    const url = new URL(client.url("/clientes", { page: 2, empty: null }));

    assert.equal(url.origin, "http://server");
    assert.equal(url.pathname, "/api/clientes");
    assert.equal(url.searchParams.get("page"), "2");
    assert.equal(url.searchParams.has("empty"), false);
  });

  it("registers the session service lazily", async () => {
    const client = createApiClient({
      url: "http://server/api",
      fetch: async () => jsonResponse({ ok: true }),
      pingInterval: 60_000,
    });

    const service = client.sessionService();
    const session = await client.session();

    assert.ok(service instanceof SessionService);
    assert.deepEqual(session, {});
    assert.equal(client.service("session"), service);
    assert.equal(client.services().has("session"), true);
  });

  it("sends bearer token from the local session cache", async () => {
    const calls = [];
    const adapter = memoryAdapter([["session", { token: "local-token", user: { id: "admin" } }]]);
    const client = createApiClient({
      url: "http://server/api",
      adapter,
      createAdapter: ({ service }) => service === "session" ? adapter : memoryAdapter(),
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), authorization: options.headers?.Authorization });
        return jsonResponse({ ok: true, data: { pong: true } });
      },
      pingInterval: 60_000,
    });

    const response = await client.request("/clientes");
    const requestCall = calls.find((call) => new URL(call.url).pathname === "/api/clientes");

    assert.equal(response.ok, true);
    assert.equal(requestCall.url, "http://server/api/clientes");
    assert.equal(requestCall.authorization, "Bearer local-token");
  });

  it("wraps network errors with an ok false response", async () => {
    const client = createApiClient({
      url: "http://server/api",
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      pingInterval: 60_000,
    });

    await assert.rejects(
      () => client.request("/clientes"),
      (error) => {
        assert.equal(error.name, "ApiClientError");
        assert.equal(error.status, 0);
        assert.equal(error.response.ok, false);
        assert.equal(error.response.message, "Failed to fetch");
        return true;
      },
    );
  });

  it("can disable automatic changes and SSE", async () => {
    const calls = [];
    const client = createApiClient({
      url: "http://server/api",
      changes: false,
      sse: false,
      pingInterval: 60_000,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        calls.push(pathname);
        if (pathname === "/api/login") return jsonResponse({ ok: true, data: { token: "token", user: { id: "admin" } } });
        if (pathname === "/api/schema.json") return jsonResponse({ schema: "1.0.0", services: [] });
        return jsonResponse({ ok: true, data: {} });
      },
    });

    await client.login({ username: "admin", password: "1234" });

    assert.equal(calls.includes("/api/changes"), false);
    assert.equal(calls.includes("/api/sse"), false);
    client.destroy();
  });

  it("syncServices uses the schema document without downloading other schemas", async () => {
    const calls = [];
    const adapters = adapterRegistry();
    const document = schemaDocument();
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        calls.push(pathname);
        if (pathname === "/api/schema.json") return jsonResponse(document);
        if (pathname === "/api/clientes") return jsonResponse({ ok: true, data: [{ id: 1, nombre: "Ana" }] });
        return jsonResponse({ ok: true, data: { pong: true } });
      },
      pingInterval: 60_000,
    });

    await wait(5);
    calls.length = 0;
    await client.syncServices();

    assert.ok(client.service("clientes") instanceof BaseService);
    assert.ok(client.service("schema") instanceof SchemaService);
    assert.deepEqual(await adapters.forService("schema").get("clientes"), {
      id: "clientes",
      create: { type: "object", required: ["nombre"] },
    });
    assert.deepEqual(calls.filter((pathname) => pathname !== "/api/ping"), ["/api/schema.json", "/api/clientes"]);
    client.destroy();
  });

  it("syncServices uses the cached schema document when the download fails", async () => {
    const adapters = adapterRegistry();
    const cachedSchema = schemaDocument();
    await adapters.forService("schema").put("document", cachedSchema);
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/schema.json") throw new Error("offline");
        return jsonResponse({ ok: true, data: { pong: true } });
      },
      pingInterval: 60_000,
    });

    await client.syncServices();

    assert.ok(client.service("clientes") instanceof BaseService);
    assert.deepEqual(await adapters.forService("schema").get("clientes"), {
      id: "clientes",
      create: { type: "object", required: ["nombre"] },
    });
  });

  it("uses a fresh cached schema document and records without network requests", async () => {
    const adapters = adapterRegistry();
    const schema = schemaDocument();
    const calls = [];
    await adapters.forService("schema").put("document", schema);
    await adapters.forService("schema").put("metadata", { id: "metadata", lastUpdateAt: new Date().toISOString() });
    await adapters.forService("schema").put("clientes", { id: "clientes", create: { type: "object" } });
    await adapters.forService("clientes").put(1, { id: 1, nombre: "Ana" });
    await adapters.root.put("sync:clientes", { id: "sync:clientes", lastUpdateAt: new Date().toISOString() });
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      changes: false,
      sse: false,
      pingInterval: 60_000,
      fetch: async (url) => {
        calls.push(new URL(String(url)).pathname);
        return jsonResponse({ ok: true, data: { pong: true } });
      },
    });

    await client.syncServices();

    assert.ok(client.service("clientes") instanceof BaseService);
    assert.deepEqual(await client.service("clientes").list(), { ok: true, data: [{ id: 1, nombre: "Ana" }] });
    assert.equal(calls.includes("/api/schema.json"), false);
    assert.equal(calls.includes("/api/clientes"), false);
    client.destroy();
  });

  it("returns a fresh cached request without contacting the server", async () => {
    const adapters = adapterRegistry();
    const calls = [];
    await adapters.root.put("cache:portal.dash:admin", {
      id: "cache:portal.dash:admin",
      data: { nombre: "Ana" },
      lastUpdateAt: new Date().toISOString(),
    });
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      fetch: async (url) => {
        calls.push(new URL(String(url)).pathname);
        return jsonResponse({ ok: true, data: { nombre: "Servidor" } });
      },
      pingInterval: 60_000,
    });

    const response = await client.cachedRequest("portal.dash:admin", "/portal/dash");

    assert.deepEqual(response.data, { nombre: "Ana" });
    assert.equal(response.cached, true);
    assert.equal(response.refresh, undefined);
    assert.equal(calls.includes("/api/portal/dash"), false);
    client.destroy();
  });

  it("refreshes an expired service cache in the background", async () => {
    const adapters = adapterRegistry();
    const schema = schemaDocument();
    let releasePull;
    const pullPending = new Promise((resolve) => { releasePull = resolve; });
    await adapters.forService("schema").put("document", schema);
    await adapters.forService("schema").put("metadata", { id: "metadata", lastUpdateAt: new Date().toISOString() });
    await adapters.forService("schema").put("clientes", { id: "clientes", create: { type: "object" } });
    await adapters.forService("clientes").put(1, { id: 1, nombre: "Ana" });
    await adapters.root.put("sync:clientes", { id: "sync:clientes", lastUpdateAt: "2020-01-01T00:00:00.000Z" });
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      changes: false,
      sse: false,
      pingInterval: 60_000,
      fetch: async (url) => {
        if (new URL(String(url)).pathname === "/api/clientes") {
          await pullPending;
          return jsonResponse({ ok: true, data: [{ id: 2, nombre: "Actualizado" }] });
        }
        return jsonResponse({ ok: true, data: { pong: true } });
      },
    });

    await client.syncServices();
    assert.deepEqual(await client.service("clientes").list(), { ok: true, data: [{ id: 1, nombre: "Ana" }] });

    releasePull();
    await wait(5);
    assert.deepEqual(await client.service("clientes").list(), { ok: true, data: [{ id: 1, nombre: "Ana" }, { id: 2, nombre: "Actualizado" }] });
    assert.equal(typeof (await adapters.root.get("sync:clientes")).lastUpdateAt, "string");
    client.destroy();
  });

  it("refreshes an expired cached request in the background", async () => {
    const adapters = adapterRegistry();
    await adapters.root.put("cache:portal.dash:admin", {
      id: "cache:portal.dash:admin",
      data: { nombre: "Ana" },
      lastUpdateAt: "2020-01-01T00:00:00.000Z",
    });
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      fetch: async (url) => {
        assert.equal(new URL(String(url)).pathname, "/api/portal/dash");
        return jsonResponse({ ok: true, data: { nombre: "Actualizado" } });
      },
      pingInterval: 60_000,
    });

    const response = await client.cachedRequest("portal.dash:admin", "/portal/dash");
    const refreshed = await response.refresh;

    assert.deepEqual(response.data, { nombre: "Ana" });
    assert.deepEqual(refreshed.data, { nombre: "Actualizado" });
    assert.deepEqual((await adapters.root.get("cache:portal.dash:admin")).data, { nombre: "Actualizado" });
    client.destroy();
  });

  it("refreshes an expired cache in the background", async () => {
    const adapters = adapterRegistry();
    const schema = schemaDocument();
    const calls = [];
    let releaseSchema;
    const schemaPending = new Promise((resolve) => { releaseSchema = resolve; });
    await adapters.forService("schema").put("document", schema);
    await adapters.forService("schema").put("metadata", { id: "metadata", lastUpdateAt: "2020-01-01T00:00:00.000Z" });
    await adapters.forService("schema").put("clientes", { id: "clientes", create: { type: "object" } });
    await adapters.forService("clientes").put(1, { id: 1, nombre: "Ana" });
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      changes: false,
      sse: false,
      pingInterval: 60_000,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        calls.push(pathname);
        if (pathname === "/api/schema.json") {
          await schemaPending;
          return jsonResponse(schema);
        }
        return jsonResponse({ ok: true, data: { pong: true } });
      },
    });

    await wait(5);
    calls.length = 0;
    await client.syncServices();

    assert.ok(client.service("clientes") instanceof BaseService);
    assert.deepEqual(await client.service("clientes").list(), { ok: true, data: [{ id: 1, nombre: "Ana" }] });
    assert.equal(calls.includes("/api/schema.json"), true);

    releaseSchema();
    await wait(5);
    assert.equal(typeof (await adapters.forService("schema").get("metadata")).lastUpdateAt, "string");
    client.destroy();
  });

  it("reuses an in-flight syncServices call", async () => {
    const adapters = adapterRegistry();
    const schema = schemaDocument();
    const calls = [];
    let releaseSchema;
    const schemaStarted = new Promise((resolve) => {
      releaseSchema = resolve;
    });
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        calls.push(pathname);
        if (pathname === "/api/schema.json") {
          await schemaStarted;
          return jsonResponse(schema);
        }
        if (pathname === "/api/clientes") return jsonResponse({ ok: true, data: [] });
        return jsonResponse({ ok: true, data: { pong: true } });
      },
      pingInterval: 60_000,
    });

    await wait(5);
    calls.length = 0;
    const first = client.syncServices();
    const second = client.syncServices();
    let secondFinished = false;
    second.then(() => { secondFinished = true; });
    await wait(1);
    assert.equal(secondFinished, false);
    releaseSchema();
    await Promise.all([first, second]);

    assert.equal(calls.filter((pathname) => pathname === "/api/schema.json").length, 1);
    assert.ok(client.service("clientes") instanceof BaseService);
  });

  it("reuses an in-flight changes request", async () => {
    const calls = [];
    let releaseChanges;
    const changesStarted = new Promise((resolve) => {
      releaseChanges = resolve;
    });
    const client = createApiClient({
      url: "http://server/api",
      changes: false,
      sse: false,
      pingInterval: 60_000,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        calls.push(pathname);
        if (pathname === "/api/changes") await changesStarted;
        return jsonResponse({ ok: true, data: [] });
      },
    });

    await wait(5);
    calls.length = 0;
    const first = client.changes("2026-01-01T00:00:00.000Z");
    const second = client.changes("2026-01-02T00:00:00.000Z");
    await wait(1);
    assert.equal(calls.filter((pathname) => pathname === "/api/changes").length, 1);

    releaseChanges();
    await Promise.all([first, second]);
    client.destroy();
  });

  it("does not overlap pings while the initial changes request is pending", async () => {
    const adapters = adapterRegistry();
    await adapters.forService("session").put("session", { token: "local-token", user: { id: "admin" } });
    let changesCalls = 0;
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      sse: false,
      pingInterval: 10,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/schema.json") return jsonResponse({ schema: "1.0.0", services: [] });
        if (pathname === "/api/changes") {
          changesCalls += 1;
          await wait(50);
        }
        return jsonResponse({ ok: true, data: [] });
      },
    });

    await wait(35);
    assert.equal(changesCalls, 1);
    client.destroy();
  });

  it("opens one SSE connection when login and ping complete together", async () => {
    const adapters = adapterRegistry();
    await adapters.forService("session").put("session", { token: "local-token", user: { id: "admin" } });
    let releaseSchema;
    const schemaStarted = new Promise((resolve) => {
      releaseSchema = resolve;
    });
    let sseCalls = 0;
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      pingInterval: 60_000,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/schema.json") {
          await schemaStarted;
          return jsonResponse({ schema: "1.0.0", services: [] });
        }
        if (pathname === "/api/login") return jsonResponse({ ok: true, data: { token: "new-token", user: { id: "admin" } } });
        if (pathname === "/api/sse") {
          sseCalls += 1;
          return new Promise(() => {});
        }
        return jsonResponse({ ok: true, data: [] });
      },
    });

    await wait(5);
    const login = client.login({ username: "admin", password: "1234" });
    releaseSchema();
    await login;
    await wait(5);
    assert.equal(sseCalls, 1);
    client.destroy();
  });

  it("expires the local session when schema document download returns unauthorized", async () => {
    const adapters = adapterRegistry();
    const events = [];
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/schema.json") return jsonResponse({ ok: false, message: "Unauthorized" }, 401);
        return jsonResponse({ ok: true, data: { pong: true } });
      },
      pingInterval: 60_000,
    });
    client.onChange((event) => events.push(event));

    await wait(5);
    await assert.rejects(() => client.syncServices(), (error) => error.status === 401);

    assert.equal(events.some((event) => event.type === "offline" && event.source === "auth-expired"), true);
  });

  it("stops ping timers and clears listeners when destroy or disconnect is called", async () => {
    let pingCount = 0;
    const client = createApiClient({
      url: "http://server/api",
      fetch: async (url) => {
        if (String(url).includes("/ping")) pingCount++;
        return jsonResponse({ ok: true, data: { pong: true } });
      },
      pingInterval: 50,
    });

    let changeEmitted = false;
    client.onChange(() => {
      changeEmitted = true;
    });

    await wait(120);
    const initialPings = pingCount;
    assert.ok(initialPings >= 1, "Ping should have run at least once");

    client.destroy();

    const countAfterDestroy = pingCount;
    await wait(120);
    assert.equal(pingCount, countAfterDestroy, "No additional pings should occur after destroy()");

    client.disconnect();
  });
});

function schemaDocument() {
  return {
    schema: "1.0.0",
    services: [
      {
        name: "clientes",
        operations: {
          list: { method: "GET", path: "/api/clientes", permissions: ["clientes.list"] },
          create: { method: "POST", path: "/api/clientes", permissions: ["clientes.create"] },
        },
        schemas: {
          create: { type: "object", required: ["nombre"] },
        },
      },
    ],
  };
}

function adapterRegistry() {
  const adapters = new Map();
  const root = memoryAdapter();

  return {
    root,
    createAdapter({ service }) {
      if (!adapters.has(service)) adapters.set(service, memoryAdapter());
      return adapters.get(service);
    },
    forService(service) {
      if (!adapters.has(service)) adapters.set(service, memoryAdapter());
      return adapters.get(service);
    },
  };
}

function memoryAdapter(entries = []) {
  const map = new Map(entries);
  return {
    async getAll() {
      return [...map.values()];
    },
    async get(key) {
      return map.get(key) ?? null;
    },
    async add(value) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) await this.put(item.id, item);
      return value;
    },
    async put(key, value) {
      map.set(key, value);
      return value;
    },
    async delete(key) {
      map.delete(key);
    },
    async clear() {
      map.clear();
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
