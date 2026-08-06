import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { Seq, SQLiteAdapter } from "seq";
import { createApiKit } from "../src/server/index.js";
import { createApiKitClient, MapAdapter, BaseService, BaseAdapter, PendingService } from "../src/client/index.js";

const modules = [
  {
    name: "clientes",
    modelName: "Cliente",
    tableName: "clientes_client_test",
    timestamps: false,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      ruc: { type: "string", unique: true },
      nombre: { type: "string", allowNull: false, title: "Nombre" },
      activo: { type: "boolean", defaultValue: true, title: "Activo" },
    },
  },
  {
    modelName: "audit",
    tableName: "audit_client_test",
    timestamps: true,
    audit: false,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      txId: { type: "string", maxLength: 50, allowNull: false },
      tableName: { type: "string", maxLength: 120, allowNull: false },
      action: { type: "string", maxLength: 30, allowNull: false },
      rowId: { type: "string", maxLength: 80 },
      old: { type: "json" },
      new: { type: "json" },
      userId: { type: "string", maxLength: 80 },
      clientIp: { type: "string", maxLength: 80 },
    },
  },
];

describe("client public API", () => {
  it("uses server login, session and bearer token for discovered service CRUD", async () => {
    const { api, server, baseUrl, seq } = await startApi();

    try {
      const adapter = new MapAdapter();
      const client = createApiKitClient({ baseUrl, adapter });
      const events = [];
      client.onChange((event) => events.push(event));

      const login = await client.login({ username: "admin", password: "1234" });
      assert.equal(login.ok, true);
      assert.equal(client.token(), login.data.token);
      assert.equal(client.connected(), true);

      const currentSession = await client.session();
      assert.equal(currentSession.user.id, "admin");

      await client.discover();
      const clientes = client.service("clientes");
      assert.ok(clientes instanceof BaseService);
      assert.deepEqual(clientes.permissions("list"), ["clientes.list"]);

      const invalid = await clientes.validate({});
      assert.equal(invalid.ok, false);
      assert.equal(invalid.errors.nombre, "Nombre es requerido");

      const invalidAttribute = await clientes.validateAt("nombre", {});
      assert.deepEqual(invalidAttribute, { ok: false, error: "Nombre es requerido" });

      const valid = await clientes.validate({ nombre: "Ana", activo: true });
      assert.deepEqual(valid, { ok: true, message: "OK", errors: null });

      const created = await clientes.create({ nombre: "Ana", ruc: "123" });
      assert.equal(created.data.nombre, "Ana");

      const listed = await clientes.list();
      assert.equal(listed.data.length, 1);
      assert.equal(listed.local, true);

      const got = await clientes.get(created.data.id);
      assert.equal(got.data.ruc, "123");

      const updated = await clientes.update(created.data.id, { activo: false });
      assert.equal(updated.data.activo, false);

      const removed = await clientes.remove(created.data.id);
      assert.equal(removed.data.id, created.data.id);
      assert.ok(events.some((event) => event.type === "online" && event.source === "login"));

      const restoredClient = createApiKitClient({ baseUrl, adapter });
      await restoredClient.discover();
      const createdWithPersistedToken = await restoredClient.service("clientes").create({ nombre: "Beto" });
      assert.equal(createdWithPersistedToken.data.nombre, "Beto");

      const logout = await restoredClient.logout();
      assert.equal(logout.ok, true);
      assert.equal(restoredClient.connected(), false);
      await client.clearSession();
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("lets services be extended with custom public methods", async () => {
    class ClienteService extends BaseService {
      buscarPorRuc(ruc) {
        return this.request("ruc", { params: { ruc } });
      }
    }

    const calls = [];
    const client = {
      request(path, options) {
        calls.push({ path, options });
        return Promise.resolve({ ok: true, data: { ruc: "123" } });
      },
    };
    const service = new ClienteService({
      client,
      name: "clientes",
      path: "/clientes",
      operations: { ruc: { method: "GET", path: "/clientes/ruc/{ruc}", permissions: ["clientes.list"] } },
      schemas: {},
    });

    const result = await service.buscarPorRuc("123");

    assert.equal(result.data.ruc, "123");
    assert.deepEqual(calls, [{ path: "/clientes/ruc/123", options: { method: "GET", query: {}, body: undefined } }]);
  });

  it("returns local session without calling the server", async () => {
    const calls = [];
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter: new MapAdapter(new Map([["api-kit:session", { token: "local-token", user: { id: "admin" } }]])),
      fetch: async (url) => {
        calls.push(String(url));
        return jsonResponse({ ok: true, data: {} });
      },
    });

    const session = await client.session();

    assert.deepEqual(session, { token: "local-token", user: { id: "admin" } });
    assert.equal(calls.some((url) => String(url).endsWith("/session")), false);
    assert.equal(client.connected(), false);
  });

  it("discovers and syncs service lists sequentially after login", async () => {
    const calls = [];
    let activeLists = 0;
    let maxActiveLists = 0;
    const adapter = new MapAdapter();
    const openapi = {
      openapi: "3.0.3",
      paths: {
        "/api/clientes": {
          get: { tags: ["clientes"], operationId: "clientes_list", "x-permissions": ["clientes.list"] },
        },
        "/api/ventas": {
          get: { tags: ["ventas"], operationId: "ventas_list", "x-permissions": ["ventas.list"] },
        },
        "/api/audit": {
          get: { tags: ["audit"], operationId: "audit_list", "x-permissions": ["audit.list"] },
        },
      },
    };
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, authorization: options.headers?.Authorization });
        if (pathname === "/api/login") return jsonResponse({ ok: true, data: { token: "token", user: { id: "admin" } } });
        if (pathname === "/api/openapi.json") return jsonResponse(openapi);
        if (pathname === "/api/clientes" || pathname === "/api/ventas") {
          activeLists += 1;
          maxActiveLists = Math.max(maxActiveLists, activeLists);
          await wait(5);
          activeLists -= 1;
          return jsonResponse({ ok: true, data: [{ id: pathname.endsWith("clientes") ? 1 : 2 }] });
        }
        if (pathname === "/api/changes") {
          return jsonResponse({
            ok: true,
            data: [
              { action: "update", tableName: "clientes", rowId: "1", old: { id: 1 }, new: { id: 1, nombre: "Ana Changes" } },
            ],
          });
        }
        if (pathname === "/api/sse") return sseResponse('data: {"ok":true}\n\n');
        if (pathname === "/api/audit") throw new Error("audit should not sync");
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const login = await client.login({ username: "admin", password: "1234" });

    assert.equal(login.ok, true);
    assert.deepEqual(calls.map((call) => call.pathname), ["/api/login", "/api/ping", "/api/openapi.json", "/api/clientes", "/api/ventas", "/api/changes", "/api/sse"]);
    assert.equal(calls.find((call) => call.pathname === "/api/openapi.json").authorization, "Bearer token");
    assert.equal(calls.find((call) => call.pathname === "/api/clientes").authorization, "Bearer token");
    assert.equal(calls.find((call) => call.pathname === "/api/ventas").authorization, "Bearer token");
    assert.equal(calls.find((call) => call.pathname === "/api/changes").authorization, "Bearer token");
    assert.equal(calls.find((call) => call.pathname === "/api/sse").authorization, "Bearer token");
    assert.equal(maxActiveLists, 1);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [{ id: 1, nombre: "Ana Changes" }]);
    assert.deepEqual(await adapter.get("api-kit:ventas"), [{ id: 2 }]);
    assert.equal(await adapter.get("api-kit:audit"), undefined);
  });

  it("skips cached service downloads after login", async () => {
    const calls = [];
    const adapter = new MapAdapter(new Map([
      ["api-kit:clientes", [{ id: 99 }]],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        calls.push(pathname);
        if (pathname === "/api/login") return jsonResponse({ ok: true, data: { token: "token", user: { id: "admin" } } });
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
            },
          });
        }
        if (pathname === "/api/changes") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/sse") return sseResponse('data: {"ok":true}\n\n');
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    await client.login({ username: "admin", password: "1234" });

    assert.deepEqual(calls, ["/api/login", "/api/ping", "/api/openapi.json", "/api/changes", "/api/sse"]);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [{ id: 99 }]);
  });

  it("downloads services with empty cache after login", async () => {
    const calls = [];
    const adapter = new MapAdapter(new Map([
      ["api-kit:clientes", []],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        calls.push(pathname);
        if (pathname === "/api/login") return jsonResponse({ ok: true, data: { token: "token", user: { id: "admin" } } });
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
            },
          });
        }
        if (pathname === "/api/clientes") return jsonResponse({ ok: true, data: [{ id: 1 }] });
        if (pathname === "/api/changes") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/sse") return sseResponse('data: {"ok":true}\n\n');
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    await client.login({ username: "admin", password: "1234" });

    assert.deepEqual(calls, ["/api/login", "/api/ping", "/api/openapi.json", "/api/clientes", "/api/changes", "/api/sse"]);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [{ id: 1 }]);
  });

  it("downloads services with empty cache when syncing", async () => {
    const calls = [];
    const adapter = new MapAdapter(new Map([
      ["api-kit:clientes", []],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        calls.push(pathname);
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
            },
          });
        }
        if (pathname === "/api/clientes") return jsonResponse({ ok: true, data: [{ id: 1 }] });
        if (pathname === "/api/changes") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/sse") return sseResponse('data: {"ok":true}\n\n');
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const result = await client.syncServices();

    assert.deepEqual(calls, ["/api/openapi.json", "/api/ping", "/api/clientes"]);
    assert.equal(result.results.clientes.skipped, undefined);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [{ id: 1 }]);
  });

  it("downloads cached services when sync force is true", async () => {
    const calls = [];
    const adapter = new MapAdapter(new Map([
      ["api-kit:clientes", [{ id: 99 }]],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        calls.push(pathname);
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
            },
          });
        }
        if (pathname === "/api/clientes") return jsonResponse({ ok: true, data: [{ id: 1 }] });
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const result = await client.syncServices(true);

    assert.equal(result.results.clientes.skipped, undefined);
    assert.deepEqual(calls, ["/api/openapi.json", "/api/ping", "/api/clientes"]);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [{ id: 1 }]);
  });

  it("reuses an in-flight service sync instead of duplicating openapi and list requests", async () => {
    const calls = [];
    const adapter = new MapAdapter(new Map([
      ["api-kit:clientes", []],
      ["api-kit:ventas", []],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        calls.push(pathname);
        if (pathname === "/api/openapi.json") {
          await wait(10);
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
              "/api/ventas": { get: { tags: ["ventas"], operationId: "ventas_list" } },
            },
          });
        }
        if (pathname === "/api/clientes") return jsonResponse({ ok: true, data: [{ id: 1 }] });
        if (pathname === "/api/ventas") return jsonResponse({ ok: true, data: [{ id: 2 }] });
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const [first, second] = await Promise.all([client.syncServices(), client.syncServices()]);

    assert.equal(first, second);
    assert.deepEqual(calls, ["/api/openapi.json", "/api/ping", "/api/clientes", "/api/ventas"]);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [{ id: 1 }]);
    assert.deepEqual(await adapter.get("api-kit:ventas"), [{ id: 2 }]);
  });

  it("resends pending operations after syncing services", async () => {
    const calls = [];
    const adapter = new MapAdapter(new Map([
      ["api-kit:clientes", [{ id: -1, nombre: "Pendiente", pending: true, status: "pending", message: "", errors: null }]],
      ["api-kit:pending", [{ id: -1, service: "clientes", operation: "create", localId: -1, data: { nombre: "Pendiente" }, status: "pending", message: "", errors: null }]],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": {
                get: { tags: ["clientes"], operationId: "clientes_list" },
                post: { tags: ["clientes"], operationId: "clientes_create" },
              },
            },
          });
        }
        if (pathname === "/api/clientes" && options.method === "POST") return jsonResponse({ ok: true, data: { id: 7, nombre: "Pendiente" } });
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const result = await client.syncServices();

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), ["GET /api/openapi.json", "GET /api/ping", "POST /api/clientes"]);
    assert.deepEqual(await adapter.get("api-kit:pending"), []);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [{ id: 7, nombre: "Pendiente" }]);
  });

  it("keeps rejected pending operations after syncing services", async () => {
    const adapter = new MapAdapter(new Map([
      ["api-kit:clientes", [{ id: -1, nombre: "x", pending: true, status: "pending", message: "", errors: null }]],
      ["api-kit:pending", [{ id: -1, service: "clientes", operation: "create", localId: -1, data: { nombre: "x" }, status: "pending", message: "", errors: null }]],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": {
                get: { tags: ["clientes"], operationId: "clientes_list" },
                post: { tags: ["clientes"], operationId: "clientes_create" },
              },
            },
          });
        }
        if (pathname === "/api/clientes" && options.method === "POST") {
          return jsonResponse({ ok: false, message: "Nombre invalido", errors: { nombre: "Muy corto" } }, 422);
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const result = await client.syncServices();

    assert.equal(result.ok, false);
    assert.equal(result.pending.ok, false);
    assert.deepEqual(await adapter.get("api-kit:pending"), [
      { id: -1, service: "clientes", operation: "create", localId: -1, data: { nombre: "x" }, status: "error", message: "Nombre invalido", errors: { nombre: "Muy corto" } },
    ]);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [
      { nombre: "x", id: -1, pending: true, status: "error", message: "Nombre invalido", errors: { nombre: "Muy corto" } },
    ]);
  });

  it("uses servicePrefix for session and service cache keys", async () => {
    const adapter = new MapAdapter();
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      servicePrefix: "demo",
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/login") return jsonResponse({ ok: true, data: { token: "token", user: { id: "admin" } } });
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": {
                get: { tags: ["clientes"], operationId: "clientes_list", "x-permissions": ["clientes.list"] },
              },
            },
          });
        }
        if (pathname === "/api/clientes") return jsonResponse({ ok: true, data: [{ id: 1 }] });
        if (pathname === "/api/changes") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/sse") return sseResponse('data: {"ok":true}\n\n');
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    await client.login({ username: "admin", password: "1234" });

    assert.deepEqual(await adapter.get("demo:session"), { token: "token", user: { id: "admin" } });
    assert.deepEqual(await adapter.get("demo:clientes"), [{ id: 1 }]);
    assert.equal(await adapter.get("api-kit:session"), undefined);
    assert.equal(await adapter.get("api-kit:clientes"), undefined);
  });

  it("clears session service caches pending data and restarts ping on logout", async () => {
    const calls = [];
    const events = [];
    const adapter = new MapAdapter(new Map([
      ["api-kit:session", { token: "token", user: { id: "admin" } }],
      ["api-kit:clientes", [{ id: 1 }]],
      ["api-kit:ventas", [{ id: 2 }]],
      ["api-kit:audit", [{ id: 3 }]],
      ["api-kit:pending", [{ id: -1, service: "clientes", operation: "create", localId: -1, data: { nombre: "Local" } }]],
      ["api-kit:temporaryId", -1],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, method: options.method || "GET", authorization: options.headers?.Authorization });
        if (pathname === "/api/ping") return jsonResponse({ ok: true, data: { pong: true } });
        if (pathname === "/api/logout") return jsonResponse({ ok: true, data: { logout: true } });
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
              "/api/ventas": { get: { tags: ["ventas"], operationId: "ventas_list" } },
              "/api/audit": { get: { tags: ["audit"], operationId: "audit_list" } },
            },
          });
        }
        if (pathname === "/api/changes") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/sse") return sseResponse('data: {"ok":true}\n\n');
        throw new Error(`Unexpected URL ${url}`);
      },
      pingInterval: 50,
      pingTimeout: 50,
    });
    client.onChange((event) => events.push(event));
    await client.discover({
      openapi: "3.0.3",
      paths: {
        "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
        "/api/ventas": { get: { tags: ["ventas"], operationId: "ventas_list" } },
        "/api/audit": { get: { tags: ["audit"], operationId: "audit_list" } },
      },
    });
    await wait(0);
    calls.length = 0;

    const logout = await client.logout();
    await wait(0);

    assert.equal(logout.ok, true);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), ["POST /api/logout", "GET /api/ping"]);
    assert.equal(calls.find((call) => call.pathname === "/api/logout").authorization, "Bearer token");
    assert.equal(await adapter.get("api-kit:session"), undefined);
    assert.equal(await adapter.get("api-kit:clientes"), undefined);
    assert.equal(await adapter.get("api-kit:ventas"), undefined);
    assert.deepEqual(await adapter.get("api-kit:audit"), [{ id: 3 }]);
    assert.equal(await adapter.get("api-kit:pending"), undefined);
    assert.equal(await adapter.get("api-kit:temporaryId"), undefined);
    assert.ok(events.some((event) => event.type === "offline" && event.source === "logout"));
    await client.clearSession();
  });

  it("makes stopConnection call logout", async () => {
    const calls = [];
    const adapter = new MapAdapter(new Map([["api-kit:session", { token: "token" }]]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, method: options.method || "GET" });
        if (pathname === "/api/ping") return jsonResponse({ ok: true, data: { pong: true } });
        if (pathname === "/api/logout") return jsonResponse({ ok: true, data: { logout: true } });
        if (pathname === "/api/openapi.json") return jsonResponse({ ok: false, message: "Unauthorized" }, 401);
        throw new Error(`Unexpected URL ${url}`);
      },
      pingInterval: 50,
      pingTimeout: 50,
    });
    await wait(0);
    calls.length = 0;

    const response = await client.stopConnection();
    await wait(0);

    assert.equal(response.ok, true);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), ["POST /api/logout", "GET /api/ping"]);
    assert.equal(await adapter.get("api-kit:session"), undefined);
    await client.clearSession();
  });

  it("exposes pending as a discovered local service", async () => {
    const adapter = new MapAdapter();
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url) => {
        throw new Error(`Unexpected URL ${url}`);
      },
    });
    const pending = client.service("pending");

    assert.ok(pending instanceof PendingService);
    const id = await pending.nextTemporaryId();
    await pending.create({ id, service: "clientes", operation: "create", localId: id, data: { nombre: "Ana" } });
    await pending.update(id, { status: "pending", message: "", errors: null });

    assert.deepEqual((await pending.list()).data, [
      { id: -1, service: "clientes", operation: "create", localId: -1, data: { nombre: "Ana" }, status: "pending", message: "", errors: null },
    ]);
    assert.deepEqual((await pending.get(id)).data, {
      id: -1,
      service: "clientes",
      operation: "create",
      localId: -1,
      data: { nombre: "Ana" },
      status: "pending",
      message: "",
      errors: null,
    });
  });

  it("creates records locally with temporary ids and pending operations while offline", async () => {
    const adapter = new MapAdapter();
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url) => {
        throw new Error(`Unexpected URL ${url}`);
      },
    });
    await client.discover({
      openapi: "3.0.3",
      paths: {
        "/api/clientes": {
          get: { tags: ["clientes"], operationId: "clientes_list", "x-permissions": ["clientes.list"] },
          post: { tags: ["clientes"], operationId: "clientes_create", "x-permissions": ["clientes.create"] },
        },
      },
    });

    const clientes = client.service("clientes");
    const created = await clientes.create({ nombre: "Offline" });
    const listed = await clientes.list();

    assert.equal(created.ok, true);
    assert.equal(created.pending, true);
    assert.equal(created.data.id, -1);
    assert.equal(created.data.nombre, "Offline");
    assert.deepEqual(listed.data, [{ nombre: "Offline", id: -1, pending: true, status: "pending", message: "", errors: null }]);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [{ nombre: "Offline", id: -1, pending: true, status: "pending", message: "", errors: null }]);
    assert.deepEqual(await adapter.get("api-kit:pending"), [
      {
        id: -1,
        service: "clientes",
        operation: "create",
        localId: -1,
        data: { nombre: "Offline" },
        status: "pending",
        message: "",
        errors: null,
        createdAt: (await adapter.get("api-kit:pending"))[0].createdAt,
      },
    ]);
    assert.equal(await adapter.get("api-kit:temporaryId"), -1);
  });

  it("automatically pushes created records while online", async () => {
    const calls = [];
    const adapter = new MapAdapter();
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, method: options.method || "GET" });
        if (pathname === "/api/login") return jsonResponse({ ok: true, data: { token: "token", user: { id: "admin" } } });
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": {
                get: { tags: ["clientes"], operationId: "clientes_list", "x-permissions": ["clientes.list"] },
                post: { tags: ["clientes"], operationId: "clientes_create", "x-permissions": ["clientes.create"] },
              },
            },
          });
        }
        if (pathname === "/api/clientes" && (options.method || "GET") === "GET") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/changes") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/sse") return sseResponse('data: {"ok":true}\n\n');
        if (pathname === "/api/clientes" && options.method === "POST") return jsonResponse({ ok: true, data: { id: 7, nombre: "Online" } });
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    await client.login({ username: "admin", password: "1234" });
    const clientes = client.service("clientes");
    const created = await clientes.create({ nombre: "Online" });

    assert.equal(created.ok, true);
    assert.equal(created.pending, false);
    assert.deepEqual(created.data, { id: 7, nombre: "Online" });
    assert.deepEqual(await adapter.get("api-kit:clientes"), [{ id: 7, nombre: "Online" }]);
    assert.deepEqual(await adapter.get("api-kit:pending"), []);
    assert.equal(await adapter.get("api-kit:temporaryId"), -1);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
      "POST /api/login",
      "GET /api/ping",
      "GET /api/openapi.json",
      "GET /api/clientes",
      "GET /api/changes",
      "GET /api/sse",
      "POST /api/clientes",
    ]);
  });

  it("automatically pushes updates and removes while online", async () => {
    const calls = [];
    const adapter = new MapAdapter();
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
        if (pathname === "/api/login") return jsonResponse({ ok: true, data: { token: "token", user: { id: "admin" } } });
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": {
                get: { tags: ["clientes"], operationId: "clientes_list", "x-permissions": ["clientes.list"] },
              },
              "/api/clientes/{id}": {
                put: { tags: ["clientes"], operationId: "clientes_update", "x-permissions": ["clientes.update"] },
                delete: { tags: ["clientes"], operationId: "clientes_remove", "x-permissions": ["clientes.remove"] },
              },
            },
          });
        }
        if (pathname === "/api/clientes" && (options.method || "GET") === "GET") return jsonResponse({ ok: true, data: [{ id: 7, nombre: "Ana" }, { id: 8, nombre: "Beto" }] });
        if (pathname === "/api/clientes/7" && options.method === "PUT") return jsonResponse({ ok: true, data: { id: 7, nombre: "Ana Online" } });
        if (pathname === "/api/clientes/8" && options.method === "DELETE") return jsonResponse({ ok: true, data: { id: 8, nombre: "Beto" } });
        if (pathname === "/api/changes") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/sse") return sseResponse('data: {"ok":true}\n\n');
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    await client.login({ username: "admin", password: "1234" });
    const clientes = client.service("clientes");
    await clientes.update(7, { nombre: "Ana Online" });
    await clientes.remove(8);

    assert.deepEqual(await adapter.get("api-kit:pending"), []);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [{ id: 7, nombre: "Ana Online" }]);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`).filter((call) => call.includes("/api/clientes/")), [
      "PUT /api/clientes/7",
      "DELETE /api/clientes/8",
    ]);
  });

  it("keeps rejected pushed creates pending with error status and message", async () => {
    const adapter = new MapAdapter();
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/login") return jsonResponse({ ok: true, data: { token: "token", user: { id: "admin" } } });
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": {
                get: { tags: ["clientes"], operationId: "clientes_list", "x-permissions": ["clientes.list"] },
                post: { tags: ["clientes"], operationId: "clientes_create", "x-permissions": ["clientes.create"] },
              },
            },
          });
        }
        if (pathname === "/api/clientes" && (options.method || "GET") === "GET") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/changes") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/sse") return sseResponse('data: {"ok":true}\n\n');
        if (pathname === "/api/clientes" && options.method === "POST") {
          return jsonResponse({ ok: false, message: "Nombre invalido", errors: { nombre: "Debe tener al menos 3 caracteres" } }, 422);
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    await client.login({ username: "admin", password: "1234" });
    const clientes = client.service("clientes");
    const created = await clientes.create({ nombre: "x" });
    const pushed = await clientes.push();
    const local = (await clientes.list()).data[0];

    assert.equal(created.ok, true);
    assert.equal(created.pending, true);
    assert.equal(created.data.id, -1);
    assert.equal(pushed.ok, false);
    assert.equal(local.status, "error");
    assert.equal(local.message, "Nombre invalido");
    assert.deepEqual(local.errors, { nombre: "Debe tener al menos 3 caracteres" });
    assert.deepEqual(await adapter.get("api-kit:clientes"), [
      {
        nombre: "x",
        id: -1,
        pending: true,
        status: "error",
        message: "Nombre invalido",
        errors: { nombre: "Debe tener al menos 3 caracteres" },
      },
    ]);
    assert.deepEqual(await adapter.get("api-kit:pending"), [
      {
        id: -1,
        service: "clientes",
        operation: "create",
        localId: -1,
        data: { nombre: "x" },
        status: "error",
        message: "Nombre invalido",
        errors: { nombre: "Debe tener al menos 3 caracteres" },
        createdAt: (await adapter.get("api-kit:pending"))[0].createdAt,
      },
    ]);
  });

  it("keeps local service data after push fails when the server drops while marked online", async () => {
    let serverOnline = true;
    const adapter = new MapAdapter();
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/login") return jsonResponse({ ok: true, data: { token: "token", user: { id: "admin" } } });
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": {
                get: { tags: ["clientes"], operationId: "clientes_list", "x-permissions": ["clientes.list"] },
                post: { tags: ["clientes"], operationId: "clientes_create", "x-permissions": ["clientes.create"] },
              },
            },
          });
        }
        if (!serverOnline) throw new Error("Server offline");
        if (pathname === "/api/clientes" && (options.method || "GET") === "GET") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/changes") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/sse") return sseResponse('data: {"ok":true}\n\n');
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    await client.login({ username: "admin", password: "1234" });
    assert.equal(client.connected(), true);
    serverOnline = false;

    const clientes = client.service("clientes");
    const created = await clientes.create({ nombre: "Cae server" });
    const pushed = await clientes.push();
    const listed = await clientes.list();

    assert.equal(created.pending, true);
    assert.equal(pushed.ok, false);
    assert.equal(listed.local, true);
    assert.deepEqual(listed.data, [
      { nombre: "Cae server", id: -1, pending: true, status: "error", message: "Server offline", errors: null },
    ]);
    assert.deepEqual(await adapter.get("api-kit:clientes"), listed.data);
  });

  it("updates and removes local pending records through service methods", async () => {
    const adapter = new MapAdapter();
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url) => {
        throw new Error(`Unexpected URL ${url}`);
      },
    });
    await client.discover({
      openapi: "3.0.3",
      paths: {
        "/api/clientes": {
          get: { tags: ["clientes"], operationId: "clientes_list", "x-permissions": ["clientes.list"] },
          post: { tags: ["clientes"], operationId: "clientes_create", "x-permissions": ["clientes.create"] },
          put: { tags: ["clientes"], operationId: "clientes_update", "x-permissions": ["clientes.update"] },
          delete: { tags: ["clientes"], operationId: "clientes_remove", "x-permissions": ["clientes.remove"] },
        },
      },
    });
    const clientes = client.service("clientes");

    await clientes.create({ nombre: "Temporal" });
    const updated = await clientes.update(-1, { email: "temporal@example.com" });

    assert.equal(updated.local, true);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [
      { nombre: "Temporal", id: -1, pending: true, status: "pending", message: "", errors: null, email: "temporal@example.com" },
    ]);
    assert.deepEqual((await adapter.get("api-kit:pending"))[0].data, { nombre: "Temporal", email: "temporal@example.com" });

    const removed = await clientes.remove(-1);

    assert.equal(removed.local, true);
    assert.deepEqual(await adapter.get("api-kit:clientes"), []);
    assert.deepEqual(await adapter.get("api-kit:pending"), []);
  });

  it("updates existing records locally and stores pending updates while offline", async () => {
    const adapter = new MapAdapter(new Map([
      ["api-kit:clientes", [{ id: 7, nombre: "Ana", email: "ana@example.com" }]],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url) => {
        throw new Error(`Unexpected URL ${url}`);
      },
    });
    await client.discover({
      openapi: "3.0.3",
      paths: {
        "/api/clientes/{id}": {
          put: { tags: ["clientes"], operationId: "clientes_update", "x-permissions": ["clientes.update"] },
        },
      },
    });

    const updated = await client.service("clientes").update(7, { nombre: "Ana Editada" });

    assert.equal(updated.local, true);
    assert.equal(updated.pending, true);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [
      { id: 7, nombre: "Ana Editada", email: "ana@example.com", pending: true, status: "pending", message: "", errors: null },
    ]);
    assert.deepEqual(await adapter.get("api-kit:pending"), [
      {
        id: -1,
        service: "clientes",
        operation: "update",
        localId: 7,
        data: { nombre: "Ana Editada" },
        status: "pending",
        message: "",
        errors: null,
        createdAt: (await adapter.get("api-kit:pending"))[0].createdAt,
      },
    ]);
  });

  it("removes existing records locally and stores pending removes while offline", async () => {
    const adapter = new MapAdapter(new Map([
      ["api-kit:clientes", [{ id: 7, nombre: "Ana" }]],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url) => {
        throw new Error(`Unexpected URL ${url}`);
      },
    });
    await client.discover({
      openapi: "3.0.3",
      paths: {
        "/api/clientes/{id}": {
          delete: { tags: ["clientes"], operationId: "clientes_remove", "x-permissions": ["clientes.remove"] },
        },
      },
    });

    const removed = await client.service("clientes").remove(7);

    assert.equal(removed.local, true);
    assert.equal(removed.pending, true);
    assert.deepEqual(await adapter.get("api-kit:clientes"), []);
    assert.deepEqual(await adapter.get("api-kit:pending"), [
      {
        id: -1,
        service: "clientes",
        operation: "remove",
        localId: 7,
        data: { id: 7, nombre: "Ana" },
        status: "pending",
        message: "",
        errors: null,
        createdAt: (await adapter.get("api-kit:pending"))[0].createdAt,
      },
    ]);
  });

  it("resends one pending record and all pending records through discovered services", async () => {
    const calls = [];
    let nextId = 1;
    const adapter = new MapAdapter();
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
        if (pathname === "/api/clientes" && options.method === "POST") {
          return jsonResponse({ ok: true, data: { id: nextId++, ...JSON.parse(options.body) } });
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });
    await client.discover({
      openapi: "3.0.3",
      paths: {
        "/api/clientes": {
          post: { tags: ["clientes"], operationId: "clientes_create", "x-permissions": ["clientes.create"] },
        },
      },
    });
    await adapter.set("api-kit:clientes", [
      { id: -1, nombre: "Uno", pending: true, status: "pending", message: "", errors: null },
      { id: -2, nombre: "Dos", pending: true, status: "pending", message: "", errors: null },
    ]);
    const pending = client.service("pending");
    await pending.create({ id: -1, service: "clientes", operation: "create", localId: -1, data: { nombre: "Uno" }, status: "pending", message: "", errors: null });
    await pending.create({ id: -2, service: "clientes", operation: "create", localId: -2, data: { nombre: "Dos" }, status: "pending", message: "", errors: null });

    const one = await pending.push(-1);
    const all = await pending.push();

    assert.equal(one.ok, true);
    assert.equal(all.ok, true);
    assert.deepEqual(calls.map((call) => call.body).filter(Boolean), [{ nombre: "Uno" }, { nombre: "Dos" }]);
    assert.deepEqual(await adapter.get("api-kit:pending"), []);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [
      { id: 1, nombre: "Uno" },
      { id: 2, nombre: "Dos" },
    ]);
  });

  it("resends pending updates and removes for existing records", async () => {
    const calls = [];
    const adapter = new MapAdapter(new Map([
      ["api-kit:clientes", [
        { id: 7, nombre: "Ana Local", pending: true, status: "pending", message: "", errors: null },
      ]],
      ["api-kit:pending", [
        { id: -1, service: "clientes", operation: "update", localId: 7, data: { nombre: "Ana Server" }, status: "pending", message: "", errors: null },
        { id: -2, service: "clientes", operation: "remove", localId: 8, data: { id: 8, nombre: "Beto" }, status: "pending", message: "", errors: null },
      ]],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
        if (pathname === "/api/clientes/7" && options.method === "PUT") return jsonResponse({ ok: true, data: { id: 7, nombre: "Ana Server" } });
        if (pathname === "/api/clientes/8" && options.method === "DELETE") return jsonResponse({ ok: true, data: { id: 8, nombre: "Beto" } });
        throw new Error(`Unexpected URL ${url}`);
      },
    });
    await client.discover({
      openapi: "3.0.3",
      paths: {
        "/api/clientes/{id}": {
          put: { tags: ["clientes"], operationId: "clientes_update", "x-permissions": ["clientes.update"] },
          delete: { tags: ["clientes"], operationId: "clientes_remove", "x-permissions": ["clientes.remove"] },
        },
      },
    });

    const result = await client.service("pending").push();

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), ["GET /api/ping", "PUT /api/clientes/7", "DELETE /api/clientes/8"]);
    assert.deepEqual(await adapter.get("api-kit:pending"), []);
    assert.deepEqual(await adapter.get("api-kit:clientes"), [{ id: 7, nombre: "Ana Server" }]);
  });

  it("tracks connection using ping and sse data without navigator state", async () => {
    const calls = [];
    const events = [];
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter: new MapAdapter(new Map([["api-kit:session", { token: "old-token" }]])),
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), authorization: options.headers?.Authorization });
        if (String(url).endsWith("/ping")) return jsonResponse({ ok: true, data: { pong: true } });
        if (String(url).endsWith("/openapi.json")) {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
              "/api/ventas": { get: { tags: ["ventas"], operationId: "ventas_list" } },
              "/api/audit": { get: { tags: ["audit"], operationId: "audit_list" } },
            },
          });
        }
        if (String(url).endsWith("/clientes")) return jsonResponse({ ok: true, data: [{ id: 1 }] });
        if (String(url).endsWith("/ventas")) return jsonResponse({ ok: true, data: [{ id: 2 }] });
        if (String(url).includes("/changes")) return jsonResponse({ ok: true, data: [] });
        if (String(url).endsWith("/sse")) return sseResponse('event: audit\ndata: {"id":1}\n\n');
        throw new Error(`Unexpected URL ${url}`);
      },
      pingInterval: 50,
      pingTimeout: 50,
      sseWatchdogTimeout: 1000,
    });
    client.onChange((event) => events.push(event));

    await wait(50);

    assert.equal(client.connected(), true);
    assert.equal(client.token(), "old-token");
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/api/ping", "/api/openapi.json", "/api/clientes", "/api/ventas", "/api/changes", "/api/sse"]);
    assert.equal(calls.find((call) => call.url.endsWith("/ping")).authorization, undefined);
    assert.equal(calls.find((call) => call.url.endsWith("/openapi.json")).authorization, "Bearer old-token");
    assert.equal(calls.find((call) => call.url.endsWith("/clientes")).authorization, "Bearer old-token");
    assert.equal(calls.find((call) => call.url.endsWith("/ventas")).authorization, "Bearer old-token");
    assert.equal(calls.find((call) => new URL(call.url).pathname.endsWith("/changes")).authorization, "Bearer old-token");
    assert.equal(calls.find((call) => call.url.endsWith("/sse")).authorization, "Bearer old-token");
    assert.doesNotThrow(() => new Date(new URL(calls.find((call) => new URL(call.url).pathname.endsWith("/changes")).url).searchParams.get("since")).toISOString());
    assert.equal(typeof client.lastReceivedAt(), "string");
    assert.ok(events.some((event) => event.type === "online" && event.source === "ping"));
    assert.ok(events.some((event) => event.type === "online" && event.source === "openapi"));
    assert.ok(events.some((event) => event.type === "online" && event.source === "changes" && event.lastReceivedAt));
    assert.ok(events.some((event) => event.type === "sse" && event.data.id === 1 && event.lastReceivedAt));
    await client.clearSession();
  });

  it("applies audit sse create update and delete events to service cache", async () => {
    const calls = [];
    const events = [];
    const adapter = new MapAdapter(new Map([
      ["api-kit:session", { token: "token" }],
      ["api-kit:clientes", [
        { id: 1, nombre: "Ana" },
        { id: 2, nombre: "Beto" },
      ]],
    ]));
    const messages = [
      { action: "create", tableName: "clientes", rowId: "3", old: null, new: { id: 3, nombre: "Cora" } },
      { action: "update", tableName: "clientes", rowId: "1", old: { id: 1, nombre: "Ana" }, new: { id: 1, nombre: "Ana SSE" } },
      { action: "delete", tableName: "clientes", rowId: "2", old: { id: 2, nombre: "Beto" }, new: null },
    ];
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, authorization: options.headers?.Authorization });
        if (pathname === "/api/ping") return jsonResponse({ ok: true, data: { pong: true } });
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
            },
          });
        }
        if (pathname === "/api/changes") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/sse") {
          return sseResponse(messages.map((message) => `event: audit\ndata: ${JSON.stringify(message)}\n\n`).join(""));
        }
        throw new Error(`Unexpected URL ${url}`);
      },
      pingInterval: 50,
      pingTimeout: 50,
      sseWatchdogTimeout: 1000,
    });
    client.onChange((event) => events.push(event));

    await wait(50);

    const cached = [...(await adapter.get("api-kit:clientes"))].sort((a, b) => Number(a.id) - Number(b.id));
    assert.deepEqual(cached, [
      { id: 1, nombre: "Ana SSE" },
      { id: 3, nombre: "Cora" },
    ]);
    assert.deepEqual(calls.map((call) => call.pathname), ["/api/ping", "/api/openapi.json", "/api/changes", "/api/sse"]);
    assert.equal(calls.find((call) => call.pathname === "/api/sse").authorization, "Bearer token");
    assert.equal(events.filter((event) => event.type === "sse").length, 3);
    await client.clearSession();
  });

  it("uses cached services during reconnect and only downloads missing service data", async () => {
    const calls = [];
    const adapter = new MapAdapter(new Map([
      ["api-kit:session", { token: "token" }],
      ["api-kit:clientes", [{ id: 1 }]],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, authorization: options.headers?.Authorization });
        if (pathname === "/api/ping") return jsonResponse({ ok: true, data: { pong: true } });
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
              "/api/ventas": { get: { tags: ["ventas"], operationId: "ventas_list" } },
            },
          });
        }
        if (pathname === "/api/ventas") return jsonResponse({ ok: true, data: [{ id: 2 }] });
        if (pathname === "/api/changes") return jsonResponse({ ok: true, data: [] });
        if (pathname === "/api/sse") return sseResponse('data: {"ok":true}\n\n');
        throw new Error(`Unexpected URL ${url}`);
      },
      pingInterval: 50,
      pingTimeout: 50,
      sseWatchdogTimeout: 1000,
    });

    await wait(50);

    assert.deepEqual(calls.map((call) => call.pathname), ["/api/ping", "/api/openapi.json", "/api/ventas", "/api/changes", "/api/sse"]);
    assert.equal(calls.find((call) => call.pathname === "/api/ping").authorization, undefined);
    assert.equal(calls.find((call) => call.pathname === "/api/openapi.json").authorization, "Bearer token");
    assert.equal(calls.find((call) => call.pathname === "/api/ventas").authorization, "Bearer token");
    assert.equal(calls.find((call) => call.pathname === "/api/changes").authorization, "Bearer token");
    assert.equal(calls.find((call) => call.pathname === "/api/sse").authorization, "Bearer token");
    assert.deepEqual(await adapter.get("api-kit:clientes"), [{ id: 1 }]);
    assert.deepEqual(await adapter.get("api-kit:ventas"), [{ id: 2 }]);
    await client.clearSession();
  });

  it("does not treat silent sse responses as alive and returns to ping after watchdog", async () => {
    const calls = [];
    const events = [];
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter: new MapAdapter(new Map([["api-kit:session", { token: "token" }]])),
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/openapi.json")) return jsonResponse({ openapi: "3.0.3", paths: {} });
        if (String(url).includes("/changes")) return jsonResponse({ ok: true, data: [] });
        if (String(url).endsWith("/sse")) return silentSseResponse();
        return jsonResponse({ ok: true, data: { user: { id: "admin" } } });
      },
      pingInterval: 20,
      pingTimeout: 20,
      sseWatchdogTimeout: 40,
    });
    client.onChange((event) => events.push(event));

    await wait(110);

    assert.equal(calls.filter((url) => url.endsWith("/ping")).length >= 2, true);
    assert.equal(calls.filter((url) => url.endsWith("/session")).length, 0);
    assert.equal(calls.filter((url) => url.endsWith("/openapi.json")).length >= 1, true);
    assert.equal(calls.filter((url) => url.includes("/changes")).length >= 2, true);
    assert.ok(events.some((event) => event.type === "offline" && event.source === "watchdog"));
    assert.equal(events.some((event) => event.type === "online" && event.source === "sse"), false);
    await client.clearSession();
  });

  it("does not call session during reconnect and does not open sse when openapi fails", async () => {
    const calls = [];
    const events = [];
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter: new MapAdapter(new Map([["api-kit:session", { token: "old-token" }]])),
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), authorization: options.headers?.Authorization });
        if (String(url).endsWith("/ping")) return jsonResponse({ ok: true, data: { pong: true } });
        if (String(url).endsWith("/openapi.json")) return jsonResponse({ ok: false, message: "Unauthorized" }, 401);
        throw new Error(`Unexpected URL ${url}`);
      },
      pingInterval: 50,
      pingTimeout: 50,
      sseWatchdogTimeout: 1000,
    });
    client.onChange((event) => events.push(event));

    await wait(50);

    assert.equal(calls.filter((call) => call.url.endsWith("/ping")).length >= 1, true);
    assert.equal(calls.filter((call) => call.url.endsWith("/session")).length, 0);
    assert.equal(calls.find((call) => call.url.endsWith("/openapi.json")).authorization, "Bearer old-token");
    assert.equal(calls.some((call) => call.url.endsWith("/sse")), false);
    assert.equal(client.connected(), true);
    assert.ok(events.some((event) => event.type === "online" && event.source === "ping"));
    await client.clearSession();
  });

  it("expires local session during reconnect when openapi returns 401", async () => {
    const calls = [];
    const events = [];
    let pingOk = false;
    const adapter = new MapAdapter(new Map([
      ["api-kit:session", { token: "old-token" }],
      ["api-kit:clientes", [{ id: 1 }]],
      ["api-kit:audit", [{ id: 2 }]],
      ["api-kit:pending", [{ id: -1, service: "clientes", operation: "create", localId: -1, data: { nombre: "Local" } }]],
      ["api-kit:temporaryId", -1],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, authorization: options.headers?.Authorization });
        if (pathname === "/api/ping") {
          if (!pingOk) return jsonResponse({ ok: false, message: "Offline" }, 503);
          return jsonResponse({ ok: true, data: { pong: true } });
        }
        if (pathname === "/api/openapi.json") return jsonResponse({ ok: false, message: "Unauthorized" }, 401);
        throw new Error(`Unexpected URL ${url}`);
      },
      pingInterval: 50,
      pingTimeout: 50,
      sseWatchdogTimeout: 1000,
    });
    client.onChange((event) => events.push(event));
    await client.discover({
      openapi: "3.0.3",
      paths: {
        "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
        "/api/audit": { get: { tags: ["audit"], operationId: "audit_list" } },
      },
    });
    await wait(0);
    pingOk = true;
    calls.length = 0;
    events.length = 0;

    await wait(70);

    assert.equal(calls.filter((call) => call.pathname === "/api/ping").length >= 1, true);
    assert.equal(calls.find((call) => call.pathname === "/api/openapi.json").authorization, "Bearer old-token");
    assert.equal(calls.some((call) => call.pathname === "/api/sse"), false);
    assert.equal(await adapter.get("api-kit:session"), undefined);
    assert.equal(await adapter.get("api-kit:clientes"), undefined);
    assert.deepEqual(await adapter.get("api-kit:audit"), [{ id: 2 }]);
    assert.equal(await adapter.get("api-kit:pending"), undefined);
    assert.equal(await adapter.get("api-kit:temporaryId"), undefined);
    assert.equal(client.token(), null);
    assert.ok(events.some((event) => event.type === "offline" && event.source === "auth-expired"));
    await client.clearSession();
  });

  it("uses lastReceivedAt as the next changes since value", async () => {
    const calls = [];
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter: new MapAdapter(),
      fetch: async (url) => {
        calls.push(String(url));
        return jsonResponse({ ok: true, data: [] });
      },
    });
    await wait(0);
    calls.length = 0;

    await client.changes("2026-08-01T12:00:00.000Z");
    const lastReceivedAt = client.lastReceivedAt();
    await client.changes();
    await client.clearSession();

    assert.equal(new URL(calls[0]).searchParams.get("since"), "2026-08-01T12:00:00.000Z");
    assert.equal(new URL(calls[1]).searchParams.get("since"), lastReceivedAt);
  });

  it("does not open sse when changes fails during reconnect", async () => {
    const calls = [];
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter: new MapAdapter(new Map([["api-kit:session", { token: "old-token" }]])),
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/ping")) return jsonResponse({ ok: true, data: { pong: true } });
        if (String(url).endsWith("/openapi.json")) return jsonResponse({ openapi: "3.0.3", paths: {} });
        if (String(url).includes("/changes")) return jsonResponse({ ok: false, message: "Changes failed" }, 500);
        throw new Error(`Unexpected URL ${url}`);
      },
      pingInterval: 50,
      pingTimeout: 50,
      sseWatchdogTimeout: 1000,
    });

    await wait(50);

    assert.equal(calls.filter((url) => url.endsWith("/ping")).length >= 1, true);
    assert.equal(calls.filter((url) => url.endsWith("/session")).length, 0);
    assert.equal(calls.filter((url) => url.endsWith("/openapi.json")).length >= 1, true);
    assert.equal(calls.filter((url) => url.includes("/changes")).length >= 1, true);
    assert.equal(calls.some((url) => url.endsWith("/sse")), false);
    assert.equal(client.connected(), true);
    await client.clearSession();
  });

  it("expires local session when changes returns 401 during reconnect", async () => {
    const calls = [];
    const events = [];
    let pingOk = false;
    const adapter = new MapAdapter(new Map([
      ["api-kit:session", { token: "old-token" }],
      ["api-kit:clientes", [{ id: 1 }]],
      ["api-kit:pending", [{ id: -1, service: "clientes", operation: "create", localId: -1, data: { nombre: "Local" } }]],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, authorization: options.headers?.Authorization });
        if (pathname === "/api/ping") {
          if (!pingOk) return jsonResponse({ ok: false, message: "Offline" }, 503);
          return jsonResponse({ ok: true, data: { pong: true } });
        }
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
            },
          });
        }
        if (pathname === "/api/changes") return jsonResponse({ ok: false, message: "Unauthorized" }, 401);
        throw new Error(`Unexpected URL ${url}`);
      },
      pingInterval: 50,
      pingTimeout: 50,
      sseWatchdogTimeout: 1000,
    });
    client.onChange((event) => events.push(event));
    await wait(0);
    pingOk = true;
    calls.length = 0;
    events.length = 0;

    await wait(70);

    assert.equal(calls.filter((call) => call.pathname === "/api/ping").length >= 1, true);
    assert.equal(calls.find((call) => call.pathname === "/api/changes").authorization, "Bearer old-token");
    assert.equal(calls.some((call) => call.pathname === "/api/sse"), false);
    assert.equal(await adapter.get("api-kit:session"), undefined);
    assert.equal(await adapter.get("api-kit:clientes"), undefined);
    assert.equal(await adapter.get("api-kit:pending"), undefined);
    assert.equal(client.lastReceivedAt(), null);
    assert.ok(events.some((event) => event.type === "offline" && event.source === "auth-expired"));
    await client.clearSession();
  });

  it("expires local session when a service list returns 401 during sync", async () => {
    const calls = [];
    const events = [];
    let pingOk = false;
    const adapter = new MapAdapter(new Map([
      ["api-kit:session", { token: "old-token" }],
      ["api-kit:clientes", []],
      ["api-kit:pending", [{ id: -1, service: "clientes", operation: "create", localId: -1, data: { nombre: "Local" } }]],
    ]));
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter,
      fetch: async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        calls.push({ pathname, authorization: options.headers?.Authorization });
        if (pathname === "/api/ping") {
          if (!pingOk) return jsonResponse({ ok: false, message: "Offline" }, 503);
          return jsonResponse({ ok: true, data: { pong: true } });
        }
        if (pathname === "/api/openapi.json") {
          return jsonResponse({
            openapi: "3.0.3",
            paths: {
              "/api/clientes": { get: { tags: ["clientes"], operationId: "clientes_list" } },
            },
          });
        }
        if (pathname === "/api/clientes") return jsonResponse({ ok: false, message: "Unauthorized" }, 401);
        throw new Error(`Unexpected URL ${url}`);
      },
      pingInterval: 50,
      pingTimeout: 50,
    });
    client.onChange((event) => events.push(event));
    await wait(0);
    pingOk = true;
    calls.length = 0;
    events.length = 0;

    await assert.rejects(() => client.syncServices(), (error) => {
      assert.equal(error.status, 401);
      return true;
    });

    assert.equal(calls.find((call) => call.pathname === "/api/clientes").authorization, "Bearer old-token");
    assert.equal(await adapter.get("api-kit:session"), undefined);
    assert.equal(await adapter.get("api-kit:clientes"), undefined);
    assert.equal(await adapter.get("api-kit:pending"), undefined);
    assert.ok(events.some((event) => event.type === "offline" && event.source === "auth-expired"));
    assert.equal(events.some((event) => event.type === "sync" && event.errors?.clientes), false);
    await client.clearSession();
  });

  it("does not call session or sse during reconnect without a local token", async () => {
    const calls = [];
    const events = [];
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter: new MapAdapter(),
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), authorization: options.headers?.Authorization });
        if (String(url).endsWith("/ping")) return jsonResponse({ ok: true, data: { pong: true } });
        throw new Error(`Unexpected URL ${url}`);
      },
      pingInterval: 50,
      pingTimeout: 50,
      sseWatchdogTimeout: 1000,
    });
    client.onChange((event) => events.push(event));

    await wait(50);

    assert.equal(calls.filter((call) => call.url.endsWith("/ping")).length >= 1, true);
    assert.equal(calls.find((call) => call.url.endsWith("/ping")).authorization, undefined);
    assert.equal(calls.some((call) => call.url.endsWith("/session")), false);
    assert.equal(calls.some((call) => call.url.endsWith("/sse")), false);
    assert.equal(client.connected(), true);
    assert.ok(events.some((event) => event.type === "online" && event.source === "ping"));
    await client.clearSession();
  });

  it("does not call session or sse during reconnect when local session has no token", async () => {
    const calls = [];
    const client = createApiKitClient({
      baseUrl: "http://server/api",
      adapter: new MapAdapter(new Map([["api-kit:session", { user: { id: "admin" } }]])),
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), authorization: options.headers?.Authorization });
        if (String(url).endsWith("/ping")) return jsonResponse({ ok: true, data: { pong: true } });
        throw new Error(`Unexpected URL ${url}`);
      },
      pingInterval: 50,
      pingTimeout: 50,
      sseWatchdogTimeout: 1000,
    });

    await wait(50);

    assert.equal(calls.filter((call) => call.url.endsWith("/ping")).length >= 1, true);
    assert.equal(calls.find((call) => call.url.endsWith("/ping")).authorization, undefined);
    assert.equal(calls.some((call) => call.url.endsWith("/session")), false);
    assert.equal(calls.some((call) => call.url.endsWith("/sse")), false);
    assert.equal(client.connected(), true);
    await client.clearSession();
  });

  it("keeps adapter persistence behind the public adapter contract", async () => {
    const adapter = new MapAdapter();
    await adapter.set("x", { ok: true });
    assert.deepEqual(await adapter.get("x"), { ok: true });
    await adapter.remove("x");
    assert.equal(await adapter.get("x"), undefined);

    const base = new BaseAdapter();
    await assert.rejects(() => base.get("x"), /debe implementarse/);
  });
});

async function startApi() {
  const adapter = new SQLiteAdapter({ database: ":memory:" });
  const seq = new Seq({ adapter, logging: false });
  const api = await createApiKit({
    seq,
    basePath: "/api",
    auth: { required: true, secret: "test-secret", tokenExpiresIn: "5m" },
    audit: true,
    openapi: { auth: true, permission: "openapi.read" },
    modules,
  });

  await seq.authenticate();
  await seq.init();
  await seq.sync({ force: true });
  await seedIam(api.auth.models, ["clientes.list", "clientes.create", "clientes.get", "clientes.update", "clientes.remove", "openapi.read", "audit.changes"]);

  const app = express();
  app.use(express.json());
  app.use(api.router);
  app.use(api.errorHandler);
  const server = await listen(app);
  const { port } = server.address();
  return { api, server, baseUrl: `http://localhost:${port}/api`, seq };
}

async function seedIam(models, permissions) {
  const user = await models.User.create({ id: "admin", password: "1234", name: "Admin", email: "admin@example.com", active: true });
  const role = await models.Role.create({ role: "admin", active: true });
  await models.UserRole.create({ userId: user.get("id"), roleId: role.get("id"), active: true });

  for (const permissionName of permissions) {
    const permission = await models.Permission.create({ permission: permissionName, active: true });
    await models.RolePermission.create({ roleId: role.get("id"), permissionId: permission.get("id"), active: true });
  }
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(text) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function silentSseResponse() {
  return new Response(
    new ReadableStream({
      start() {},
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
