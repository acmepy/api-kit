import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { Seq, SQLiteAdapter } from "seq";
import { createApiKit, defineResource } from "../src/index.js";

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
      assert.equal(infos[0][0], "[api-kit]");
      assert.equal(infos[0][1], "request");
      assert.equal(infos[0][2], "tx-123");
      assert.equal(typeof infos[0][3], "string");
      assert.equal(infos[0][4], "GET");
      assert.equal(infos[0][5], "/api/openapi.json");
      assert.equal(infos[0][6], 200);
      assert.equal(typeof infos[0][7], "number");
      assert.ok(infos[0][7] >= 0);
      assert.equal(Number(infos[0][8]), Number(res.headers["content-length"] || 0));
      assert.equal(infos[0][9], "api-kit-test");
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
      paths: { services: "./example/services" },
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

      assert.equal(warnings[0][0], "[api-kit]");
      assert.equal(warnings[0][1], "http.error");
      const customLog = warnings[0][2];
      assert.equal(customLog.status, 404);
      assert.equal(customLog.code, "NOT_FOUND");
      assert.equal(customLog.method, "GET");
      assert.equal(customLog.path, "/api/clientes/ruc/80000000-0");
      assert.equal(typeof customLog.txId, "string");
      assert.equal(customLog.stack, undefined);

      const crudLog = warnings[1][2];
      assert.equal(crudLog.status, 404);
      assert.equal(crudLog.method, "GET");
      assert.equal(crudLog.path, "/api/clientes/999");
      const res = await request(server, "GET", "/api/fail");

      assert.equal(res.status, 500);
      assert.equal(errors.length, 1);
      assert.equal(errors[0][0], "[api-kit]");
      assert.equal(errors[0][1], "http.error");
      const entry = errors[0][2];
      assert.equal(entry.status, 500);
      assert.equal(entry.code, "INTERNAL_ERROR");
      assert.equal(entry.method, "GET");
      assert.equal(entry.path, "/api/fail");
      assert.match(entry.stack, /Error: Boom/);
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
