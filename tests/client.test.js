import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApiClient, BaseService, OpenapiService, SchemaService, SessionService } from "../src/client/index.js";

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
        assert.equal(error.name, "ApiKitClientError");
        assert.equal(error.status, 0);
        assert.equal(error.response.ok, false);
        assert.equal(error.response.message, "Failed to fetch");
        return true;
      },
    );
  });

  it("syncServices downloads OpenAPI, registers services and stores schemas", async () => {
    const calls = [];
    const adapters = adapterRegistry();
    const openapi = openapiDocument();
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, method: options.method || "GET", cache: options.cache });
        if (pathname === "/api/openapi.json") return jsonResponse(openapi);
        if (pathname === "/api/clientes/schema") {
          return jsonResponse({ ok: true, data: { create: { type: "object", required: ["nombre"] } } });
        }
        if (pathname === "/api/clientes") return jsonResponse({ ok: true, data: [{ id: 1, nombre: "Ana" }] });
        return jsonResponse({ ok: true, data: { pong: true } });
      },
      pingInterval: 60_000,
    });

    await wait(5);
    calls.length = 0;
    await client.syncServices();

    assert.ok(client.service("openapi") instanceof OpenapiService);
    assert.ok(client.service("schema") instanceof SchemaService);
    assert.ok(client.service("clientes") instanceof BaseService);
    assert.deepEqual(await adapters.forService("openapi").get("document"), openapi);
    assert.deepEqual(await adapters.forService("schema").get("clientes"), {
      id: "clientes",
      create: { type: "object", required: ["nombre"] },
    });
    assert.deepEqual(calls.map((call) => call.pathname).filter((pathname) => pathname !== "/api/ping"), ["/api/openapi.json", "/api/clientes/schema", "/api/clientes"]);
    assert.equal(calls.find((call) => call.pathname === "/api/openapi.json").cache, "no-store");
  });

  it("syncServices uses cached OpenAPI when the download fails", async () => {
    const adapters = adapterRegistry();
    const cachedOpenapi = openapiDocument();
    await adapters.forService("openapi").add(cachedOpenapi);
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/openapi.json") throw new Error("offline");
        if (pathname === "/api/clientes/schema") return jsonResponse({ ok: true, data: { create: { type: "object" } } });
        return jsonResponse({ ok: true, data: { pong: true } });
      },
      pingInterval: 60_000,
    });

    await client.syncServices();

    assert.ok(client.service("clientes") instanceof BaseService);
    assert.deepEqual(await adapters.forService("schema").get("clientes"), {
      id: "clientes",
      create: { type: "object" },
    });
  });

  it("reuses an in-flight syncServices call", async () => {
    const adapters = adapterRegistry();
    const openapi = openapiDocument();
    const calls = [];
    let releaseOpenapi;
    const openapiStarted = new Promise((resolve) => {
      releaseOpenapi = resolve;
    });
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        calls.push(pathname);
        if (pathname === "/api/openapi.json") {
          await openapiStarted;
          return jsonResponse(openapi);
        }
        if (pathname === "/api/clientes/schema") return jsonResponse({ ok: true, data: { create: { type: "object" } } });
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
    releaseOpenapi();
    await Promise.all([first, second]);

    assert.equal(calls.filter((pathname) => pathname === "/api/openapi.json").length, 1);
    assert.ok(client.service("clientes") instanceof BaseService);
  });

  it("expires the local session when schema download returns unauthorized", async () => {
    const adapters = adapterRegistry();
    const openapi = openapiDocument();
    const events = [];
    const client = createApiClient({
      url: "http://server/api",
      adapter: adapters.root,
      createAdapter: adapters.createAdapter,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/openapi.json") return jsonResponse(openapi);
        if (pathname === "/api/clientes/schema") return jsonResponse({ ok: false, message: "Unauthorized" }, 401);
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

function openapiDocument() {
  return {
    openapi: "3.0.3",
    paths: {
      "/api/clientes": {
        get: { tags: ["clientes"], operationId: "clientes_list" },
      },
      "/api/clientes/schema": {
        get: { tags: ["clientes"], operationId: "clientes_schema" },
      },
      "/api/ping": {
        get: { tags: ["system"], operationId: "system_ping" },
      },
      "/api/audit": {
        get: { tags: ["audit"], operationId: "audit_changes" },
      },
    },
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
