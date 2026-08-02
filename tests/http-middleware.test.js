import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { Seq, SQLiteAdapter } from "seq";
import { createApiKit, defineResource } from "../src/server/index.js";

const loggedClienteResource = defineResource({
  modelName: "LoggedCliente",
  tableName: "logged_clientes",
  attributes: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    ruc: { type: "string", unique: true, maxLength: 20 },
    nombre: { type: "string", allowNull: false },
  },
});

describe("http middleware", () => {
  it("returns an express app with routes and error handling mounted", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      openapi: {},
      modules: [],
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    api.router.get("/api/fail-app", async () => {
      throw new Error("App boom");
    });

    const server = await listen(api.app);

    try {
      const ok = await request(server, "GET", "/api/openapi.json");
      const welcome = await request(server, "GET", "/api");
      const fail = await request(server, "GET", "/api/fail-app");
      const missing = await request(server, "GET", "/missing");

      assert.equal(typeof api.app.listen, "function");
      assert.equal(ok.status, 200);
      assert.equal(ok.body.openapi, "3.0.3");
      assert.equal(welcome.status, 200);
      assert.deepEqual(welcome.body, { ok: true, data: { name: "api-kit", message: "Bienvenido al backend de api-kit" } });
      assert.equal(fail.status, 500);
      assert.equal(fail.body.code, "INTERNAL_ERROR");
      assert.equal(fail.body.message, "App boom");
      assert.equal(missing.status, 404);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("uses and returns the provided express app", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const app = express();
    app.get("/health", (_req, res) => res.json({ ok: true }));
    const api = await createApiKit({
      seq,
      app,
      basePath: "/api",
      openapi: {},
      modules: [],
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const server = await listen(app);

    try {
      const health = await request(server, "GET", "/health");
      const openapi = await request(server, "GET", "/api/openapi.json");

      assert.equal(api.app, app);
      assert.deepEqual(health.body, { ok: true });
      assert.equal(openapi.status, 200);
      assert.equal(openapi.body.openapi, "3.0.3");
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("can enable cors, helmet, and compression from createApiKit options", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      openapi: {},
      cors: { origin: "https://example.com" },
      helmet: true,
      compression: { threshold: 0 },
      modules: [],
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const res = await request(server, "GET", "/api/openapi.json", {
        headers: {
          "Accept-Encoding": "gzip",
          Origin: "https://example.com",
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers["access-control-allow-origin"], "https://example.com");
      assert.equal(res.headers["x-dns-prefetch-control"], "off");
      assert.equal(res.headers["content-encoding"], "gzip");
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("can enable rate limit and trust proxy from createApiKit options", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      openapi: {},
      trustProxy: 1,
      rateLimit: {
        windowMs: 60_000,
        limit: 1,
        standardHeaders: true,
        legacyHeaders: false,
      },
      modules: [],
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      assert.equal(app.get("trust proxy"), false);
      const first = await request(server, "GET", "/api/openapi.json", { headers: { "X-Forwarded-For": "203.0.113.10" } });
      const second = await request(server, "GET", "/api/openapi.json", { headers: { "X-Forwarded-For": "203.0.113.10" } });

      assert.equal(first.status, 200);
      assert.equal(second.status, 429);
      assert.equal(app.get("trust proxy"), 1);
      assert.ok(second.headers["retry-after"]);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("can parse text/plain bodies while coexisting with express json", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      text: true,
      modules: [],
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    api.router.post("/api/echo", (req, res) => {
      res.json({ type: typeof req.body, body: req.body });
    });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const text = await request(server, "POST", "/api/echo", {
        headers: { "Content-Type": "text/plain" },
        body: "hola texto",
      });
      assert.equal(text.status, 200);
      assert.deepEqual(text.body, { type: "string", body: "hola texto" });

      const json = await request(server, "POST", "/api/echo", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hola: "json" }),
      });
      assert.equal(json.status, 200);
      assert.deepEqual(json.body, { type: "object", body: { hola: "json" } });
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("serves a package welcome message at the base path", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      baseDir: process.cwd(),
      basePath: "/api",
      openapi: {},
      modules: [],
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const server = await listen(api.app);

    try {
      const welcome = await request(server, "GET", "/api");
      const ping = await request(server, "GET", "/api/ping");
      const openapi = await request(server, "GET", "/api/openapi.json");

      assert.equal(welcome.status, 200);
      assert.deepEqual(welcome.body, { ok: true, data: { name: "api-kit", message: "Bienvenido al backend de api-kit" } });
      assert.equal(ping.status, 200);
      assert.deepEqual(ping.body, { ok: true, data: { pong: true } });
      assert.ok(openapi.body.paths["/api"].get);
      assert.ok(openapi.body.paths["/api/ping"].get);
      assert.equal(openapi.body.paths["/api"].get.operationId, "system_welcome");
      assert.equal(openapi.body.paths["/api/ping"].get.operationId, "system_ping");
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("parses application/json bodies by default", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      modules: [],
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    api.router.post("/api/echo-json", (req, res) => {
      res.json({ type: typeof req.body, body: req.body });
    });

    const app = express();
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const json = await request(server, "POST", "/api/echo-json", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hola: "json" }),
      });

      assert.equal(json.status, 200);
      assert.deepEqual(json.body, { type: "object", body: { hola: "json" } });
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("creates master-detail records from inline detail module definitions", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      modules: [
        {
          modelName: "Venta",
          tableName: "ventas",
          timestamps: false,
          attributes: {
            id: { type: "integer", primaryKey: true, autoIncrement: true },
            cliente: { type: "string", allowNull: false },
            total: { type: "decimal", precision: 12, scale: 2, allowNull: false, defaultValue: 0 },
          },
          details: [
            {
              modelName: "VentaItem",
              tableName: "venta_items",
              timestamps: false,
              attributes: {
                id: { type: "integer", primaryKey: true, autoIncrement: true },
                ventaId: { type: "integer", allowNull: false, create: false, update: false },
                producto: { type: "string", allowNull: false },
                cantidad: { type: "integer", allowNull: false },
              },
            },
          ],
        },
      ],
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const server = await listen(api.app);

    try {
      const created = await request(server, "POST", "/api/ventas", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente: "Ana",
          total: 2,
          items: [{ producto: "Mouse", cantidad: 2 }],
        }),
      });

      assert.equal(created.status, 200);
      assert.equal(created.body.data.cliente, "Ana");
      assert.equal(created.body.data.items.length, 1);
      assert.equal(created.body.data.items[0].ventaId, created.body.data.id);

      const detail = await request(server, "POST", `/api/ventas/${created.body.data.id}/items`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: "Teclado", cantidad: 1 }),
      });

      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.producto, "Teclado");
      assert.equal(detail.body.data.ventaId, created.body.data.id);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("can serve static app files with spa fallback from modules config", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      modules: {
        modules: [{ mountPath: "/admin", path: "./tests/fixtures/vue-app" }],
      },
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const index = await request(server, "GET", "/admin");
      assert.equal(index.status, 200);
      assert.match(index.raw, /Vue shell/);

      const route = await request(server, "GET", "/admin/users/42");
      assert.equal(route.status, 200);
      assert.match(route.raw, /Vue shell/);

      const asset = await request(server, "GET", "/admin/app.js");
      assert.equal(asset.status, 200);
      assert.match(asset.raw, /vue asset/);

      const missingAsset = await request(server, "GET", "/admin/missing.js");
      assert.equal(missingAsset.status, 404);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("serves the basic example without the client package or browser persistence", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      modules: "./example/modules.js",
      auth: { required: true, secret: "test-secret", strategies: ["bearer", "basic"] },
      audit: true,
      openapi: true,
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const index = await request(server, "GET", "/basic");
      assert.equal(index.status, 200);
      assert.match(index.raw, /api-kit basic/);

      const asset = await request(server, "GET", "/basic/app.js");
      assert.equal(asset.status, 200);
      assert.match(asset.raw, /fetch/);
      assert.doesNotMatch(asset.raw, /api-kit\/client/);
      assert.doesNotMatch(asset.raw, /Promise\.all/);
      assert.doesNotMatch(asset.raw, /localStorage|sessionStorage|indexedDB|IndexedDB/);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("serves the client example using only the client package for API calls", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      modules: "./example/modules.js",
      auth: { required: true, secret: "test-secret", strategies: ["bearer", "basic"] },
      audit: true,
      openapi: true,
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const index = await request(server, "GET", "/client");
      assert.equal(index.status, 200);
      assert.match(index.raw, /api-kit client/);
      assert.match(index.raw, /api-kit\/client/);

      const asset = await request(server, "GET", "/client/app.js");
      assert.equal(asset.status, 200);
      assert.match(asset.raw, /createApiKitClient/);
      assert.match(asset.raw, /LocalStorageAdapter/);
      assert.match(asset.raw, /client\.connected\(\)/);
      assert.match(asset.raw, /client\.serviceData\("clientes"\)/);
      assert.match(asset.raw, /state\.clientes = await client\.serviceData\("clientes"\)/);
      assert.match(asset.raw, /state\.ventas = await client\.serviceData\("ventas"\)/);
      assert.match(asset.raw, /data-action="edit-cliente"/);
      assert.match(asset.raw, /data-action="delete-cliente"/);
      assert.match(asset.raw, /services\.clientes\.update/);
      assert.match(asset.raw, /services\.clientes\.remove/);
      assert.match(asset.raw, /client\.pending\(\)/);
      assert.match(asset.raw, /data-action="edit-pending"/);
      assert.match(asset.raw, /data-action="delete-pending"/);
      assert.match(asset.raw, /data-action="send-pending"/);
      assert.match(asset.raw, /data-action="send-all-pending"/);
      assert.match(asset.raw, /client\.resendPending/);
      assert.match(asset.raw, /client\.resendAllPending/);
      assert.match(asset.raw, /savePending/);
      assert.match(asset.raw, /client\.updatePending/);
      assert.match(asset.raw, /deletePending/);
      assert.match(asset.raw, /loadCachedLists/);
      assert.match(asset.raw, /client\.syncServices/);
      assert.doesNotMatch(asset.raw, /\.list\(/);
      assert.doesNotMatch(asset.raw, new RegExp("client\\.start" + "Connection\\("));
      assert.doesNotMatch(asset.raw, /client\.discover\(/);
      assert.doesNotMatch(asset.raw, /fetch\s*\(/);
      assert.doesNotMatch(asset.raw, /XMLHttpRequest|EventSource|WebSocket|axios|superagent|navigator\.onLine/);
      assert.doesNotMatch(asset.raw, /Promise\.all/);
      assert.doesNotMatch(asset.raw, /sessionStorage|indexedDB|IndexedDB/);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("can merge static app module entries from multiple module files", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      modules: ["./tests/fixtures/static-bundle-a.js", "./tests/fixtures/static-bundle-b.js"],
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const admin = await request(server, "GET", "/admin/users");
      assert.equal(admin.status, 200);
      assert.match(admin.raw, /Vue shell/);

      const portal = await request(server, "GET", "/portal/dashboard");
      assert.equal(portal.status, 200);
      assert.match(portal.raw, /Portal shell/);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("ignores staticFiles passed directly to createApiKit", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      modules: [],
      staticFiles: { mountPath: "/legacy", path: "./tests/fixtures/vue-app" },
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const asset = await request(server, "GET", "/legacy/app.js");
      assert.equal(asset.status, 404);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("ignores staticFiles and static exports from module bundles", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      modules: "./tests/fixtures/legacy-static-bundle.js",
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const staticFilesAsset = await request(server, "GET", "/legacy-static-files/app.js");
      const staticAsset = await request(server, "GET", "/legacy-static/dashboard");

      assert.equal(staticFilesAsset.status, 404);
      assert.equal(staticAsset.status, 404);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("logs requests through the api-kit logger", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const infos = [];
    const api = await createApiKit({
      seq,
      basePath: "/api",
      openapi: {},
      logging: {
        info: (...args) => infos.push(args),
      },
      modules: [],
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const res = await request(server, "GET", "/api/openapi.json", {
        headers: {
          "X-Transaction-Id": "tx-123",
          "User-Agent": "api-kit-test",
        },
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(res.status, 200);
      assert.equal(infos.length, 1);
      assert.equal(infos[0][0], "[api-kit] [request]");
      assert.equal(infos[0][1], "tx-123");
      assert.equal(typeof infos[0][2], "string");
      assert.equal(infos[0][3], "GET");
      assert.equal(infos[0][4], "/api/openapi.json");
      assert.equal(infos[0][5], 200);
      assert.equal(typeof infos[0][6], "number");
      assert.ok(infos[0][6] >= 0);
      assert.equal(Number(infos[0][7]), Number(res.headers["content-length"] || 0));
      assert.equal(infos[0][8], "api-kit-test");
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("logs HTTP errors through configured logging levels", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const warnings = [];
    const errors = [];
    const api = await createApiKit({
      seq,
      baseDir: process.cwd(),
      basePath: "/api",
      paths: { services: "./tests/fixtures/services" },
      logging: {
        warn: (...args) => warnings.push(args),
        error: (...args) => errors.push(args),
      },
      modules: [
        {
          name: "clientes",
          basePath: "/clientes",
          resource: loggedClienteResource,
          endpoints: {
            ruc: { method: "get", path: "/ruc/:ruc", summary: "Buscar por RUC" },
          },
        },
      ],
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(api.router);
    app.get("/api/fail", async () => {
      throw new Error("Boom");
    });
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const custom = await request(server, "GET", "/api/clientes/ruc/80000000-0");
      const crud = await request(server, "GET", "/api/clientes/999");

      assert.equal(custom.status, 404);
      assert.equal(custom.body.code, "NOT_FOUND");
      assert.equal(crud.status, 404);
      assert.equal(crud.body.code, "NOT_FOUND");
      assert.equal(errors.length, 0);
      assert.equal(warnings.length, 2);

      assert.equal(warnings[0][0], "[api-kit] [http.error]");
      assert.match(warnings[0][1], /^\[[^\]]+\]$/);
      assert.equal(warnings[0][2], "NotFoundError");
      assert.equal(warnings[0][4], 404);
      assert.equal(warnings[0][5], "NOT_FOUND");
      assert.equal(warnings[0][6], "GET");
      assert.equal(warnings[0][7], "/api/clientes/ruc/80000000-0");
      assert.equal(warnings[0][9], false);

      assert.equal(warnings[1][0], "[api-kit] [http.error]");
      assert.equal(warnings[1][4], 404);
      assert.equal(warnings[1][6], "GET");
      assert.equal(warnings[1][7], "/api/clientes/999");
      const res = await request(server, "GET", "/api/fail");

      assert.equal(res.status, 500);
      assert.equal(errors.length, 1);
      assert.equal(errors[0][0], "[api-kit] [http.error]");
      assert.match(errors[0][1], /^\[[^\]]+\]$/);
      assert.equal(errors[0][2], "Error");
      assert.equal(errors[0][3], "Boom");
      assert.equal(errors[0][4], 500);
      assert.equal(errors[0][5], "INTERNAL_ERROR");
      assert.equal(errors[0][6], "GET");
      assert.equal(errors[0][7], "/api/fail");
      assert.match(errors[0][9].stack, /Error: Boom/);
    } finally {
      await api.close();
      await close(server);
    }
  });
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(server, method, path, options = {}) {
  const { port } = server.address();
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Length"] = Buffer.byteLength(options.body);

  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "localhost", port, path, method, headers }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body, raw });
      });
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
