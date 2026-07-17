import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createApiKit } from "../src/api-kit.js";
import { getContext } from "../src/index.js";
import { Seq, SQLiteAdapter, Model, DataTypes } from "seq";

class Cliente extends Model {
  static define(seq) {
    return this.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        nombre: { type: DataTypes.STRING(100), allowNull: false },
        email: { type: DataTypes.STRING(150), allowNull: true },
        activo: { type: DataTypes.BOOLEAN, defaultValue: true },
      },
      { seq, modelName: "Cliente", tableName: "clientes", timestamps: true },
    );
  }
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    const req = http.request(
      { hostname: "localhost", port: 3001, path, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = null; }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

let server;
let api;

before(async () => {
  const adapter = new SQLiteAdapter({ database: ":memory:" });
  const seq = new Seq({ adapter, models: [Cliente] });
  await seq.authenticate();
  await seq.init();
  await seq.sync({ force: true });

  const app = express();
  app.use(express.json());

  api = await createApiKit({
    seq,
    baseDir: process.cwd(),
    models: { Cliente },
    modules: [
      {
        name: "clientes",
        basePath: "/api/clientes",
        model: "Cliente",
        tags: ["Clientes"],
        endpoints: {
          list: { enabled: true, permission: "clientes.list" },
          getById: { enabled: true, permission: "clientes.read" },
          create: { enabled: true, permission: "clientes.create" },
          update: { enabled: true, permission: "clientes.update" },
          remove: { enabled: true, permission: "clientes.delete" },
        },
      },
    ],
  });

  app.use(api.router);
  app.use(api.errorHandler);

  await new Promise((resolve) => {
    server = app.listen(3001, resolve);
  });
});

after(async () => {
  await api.close();
  await new Promise((resolve) => server.close(resolve));
});

describe("Etapa 1 - Núcleo", () => {
  describe("createApiKit()", () => {
    it("returns router", () => {
      assert.ok(api.router);
    });

    it("returns modules map", () => {
      assert.ok(api.modules instanceof Map);
      assert.equal(api.modules.size, 1);
      assert.ok(api.modules.has("clientes"));
    });

    it("returns models map", () => {
      assert.ok(api.models instanceof Map);
      assert.ok(api.models.has("clientes"));
    });

    it("returns services map", () => {
      assert.ok(api.services instanceof Map);
      assert.ok(api.services.has("clientes"));
    });

    it("returns routes registry", () => {
      assert.ok(api.routes);
      assert.ok(api.routes.size > 0);
    });

    it("exposes errorHandler", () => {
      assert.equal(typeof api.errorHandler, "function");
    });
  });

  describe("CRUD - list", () => {
    it("returns empty list", async () => {
      const res = await request("GET", "/api/clientes");
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.ok(Array.isArray(res.body.data));
      assert.deepEqual(res.body.pagination, { page: 1, size: 20, total: 0, pages: 0 });
    });

    it("supports page/size", async () => {
      const res = await request("GET", "/api/clientes?page=1&size=10");
      assert.equal(res.status, 200);
      assert.equal(res.body.pagination.size, 10);
    });
  });

  describe("CRUD - create", () => {
    it("creates a record", async () => {
      const res = await request("POST", "/api/clientes", {
        nombre: "Juan Pérez",
        email: "juan@test.com",
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.nombre, "Juan Pérez");
      assert.equal(typeof res.body.data.id, "number");
    });
  });

  describe("CRUD - getById", () => {
    it("returns a record", async () => {
      const res = await request("GET", "/api/clientes/1");
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.nombre, "Juan Pérez");
    });

    it("returns 404 for missing record", async () => {
      const res = await request("GET", "/api/clientes/9999");
      assert.equal(res.status, 404);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, "NOT_FOUND");
    });
  });

  describe("CRUD - update", () => {
    it("updates a record", async () => {
      const res = await request("PUT", "/api/clientes/1", {
        nombre: "Juan Actualizado",
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.nombre, "Juan Actualizado");
    });
  });

  describe("CRUD - list with data", () => {
    it("lists records with pagination", async () => {
      const res = await request("GET", "/api/clientes");
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.pagination.total, 1);
    });
  });

  describe("CRUD - remove", () => {
    it("deletes a record", async () => {
      const res = await request("DELETE", "/api/clientes/1");
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it("returns 404 after deletion", async () => {
      const res = await request("GET", "/api/clientes/1");
      assert.equal(res.status, 404);
    });
  });

  describe("Error handling", () => {
    it("handles invalid JSON", async () => {
      const res = await new Promise((resolve) => {
        const req = http.request(
          { hostname: "localhost", port: 3001, path: "/api/clientes", method: "POST", headers: { "Content-Type": "application/json" } },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              let parsed;
              try { parsed = JSON.parse(raw); } catch { parsed = null; }
              resolve({ status: res.statusCode, body: parsed });
            });
          },
        );
        req.write("{invalid");
        req.end();
      });
      assert.equal(res.status, 400);
      assert.equal(res.body?.ok, false);
    });

    it("handles unknown routes", async () => {
      const res = await request("GET", "/ruta-inexistente");
      assert.equal(res.status, 404);
    });
  });

  describe("RouteRegistry", () => {
    it("registers all routes", () => {
      assert.ok(api.routes.size >= 5);
    });

    it("can search by module", () => {
      const clientesRoutes = [...api.routes.findBy({ module: "clientes" })];
      assert.ok(clientesRoutes.length >= 5);
    });

    it("detects duplicates", () => {
      assert.throws(() => {
        api.routes.register({
          module: "test",
          method: "get",
          expressPath: "/api/clientes",
          operationId: "test.dup",
        });
      }, /Duplicate route/);
    });
  });

  describe("AsyncLocalStorage context", () => {
    it("getContext is exported", () => {
      assert.equal(typeof getContext, "function");
    });
  });
});
