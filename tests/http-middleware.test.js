import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { Seq, SQLiteAdapter } from "seq";
import { createApiKit } from "../src/index.js";

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

  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "localhost", port, path, method, headers: options.headers || {} }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}
