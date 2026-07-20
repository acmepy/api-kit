import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import packageInfo from "../package.json" with { type: "json" };
import { createApiKit, defineResource } from "../src/index.js";
import { getContext } from "../src/index.js";
import { normalizeModule } from "../src/config/config-normalizer.js";
import { Seq, SQLiteAdapter } from "seq";

const clienteResource = defineResource({
  modelName: "Cliente",
  tableName: "clientes",
  timestamps: true,
  attributes: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    nombre: { type: "string", maxLength: 100, allowNull: false, title: "Nombre", max: 100 },
    email: { type: "string", maxLength: 150, unique: true, allowNull: true, title: "Email", email: true },
    activo: { type: "boolean", defaultValue: true, title: "Activo" },
  },
});


const productoResource = defineResource({
  modelName: "Producto",
  tableName: "productos",
  attributes: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    descripcion: { type: "string", maxLength: 120, allowNull: false, title: "Nombre", max: 120 },
    precio: { type: "decimal", precision: 12, scale: 2, allowNull: false, defaultValue: 0, title: "Precio", min: 0 },
    cantidad: { type: "number", precision: 8, scale: 3, title: "Cantidad" },
    activo: { type: "boolean", defaultValue: true, title: "Activo" },
  },
});
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
  const seq = new Seq({ adapter, models: [clienteResource.model, productoResource.model] });
  await seq.authenticate();
  await seq.init();
  await seq.sync({ force: true });

  const app = express();
  app.use(express.json());

  api = await createApiKit({
    seq,
    baseDir: process.cwd(),
    basePath: "/api",
    openapi: {},
    modules: [
      {
        name: "clientes",
        basePath: "/clientes",
        resource: clienteResource,
        tags: ["Clientes"],
        endpoints: {
          list: { permission: "clientes.list" },
          get: { permission: "clientes.read" },
          create: { permission: "clientes.create" },
          update: { permission: "clientes.update" },
          remove: { permission: "clientes.delete" },
        },
      },
      {
        name: "clientes-sin-schema",
        basePath: "/clientes-sin-schema",
        resource: clienteResource,
        schema: false,
      },
      {
        name: "productos",
        basePath: "/productos",
        resource: productoResource,
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

describe("Etapa 1 - N�cleo", () => {
  describe("createApiKit()", () => {
    it("returns router", () => {
      assert.ok(api.router);
    });

    it("returns modules map", () => {
      assert.ok(api.modules instanceof Map);
      assert.equal(api.modules.size, 3);
      assert.ok(api.modules.has("clientes"));
      assert.ok(api.modules.has("clientes-sin-schema"));
      assert.ok(api.modules.has("productos"));
    });

    it("returns models map", () => {
      assert.ok(api.models instanceof Map);
      assert.ok(api.models.has("clientes"));
    });

    it("returns services map", () => {
      assert.ok(api.services instanceof Map);
      assert.ok(api.services.has("clientes"));
    });

    it("returns schemas map", () => {
      assert.ok(api.schemas instanceof Map);
      assert.equal(api.schemas.get("clientes"), clienteResource.schemas);
    });

    it("returns routes registry", () => {
      assert.ok(api.routes);
      assert.ok(api.routes.size > 0);
    });

    it("exposes errorHandler", () => {
      assert.equal(typeof api.errorHandler, "function");
    });
  });

  describe("defineResource()", () => {
    it("builds model attributes from the resource definition", () => {
      assert.equal(clienteResource.attributes.nombre.allowNull, false);
      assert.equal(clienteResource.attributes.email.allowNull, true);
      assert.equal(clienteResource.attributes.email.type.options.length, 150);
    });

    it("builds create and update schemas from the same validations", async () => {
      const createResult = await clienteResource.schemas.create.validate({ nombre: "Ana", email: null });
      assert.deepEqual(createResult, { nombre: "Ana", email: null, activo: true });

      const updateResult = await clienteResource.schemas.update.validate({ email: "ana@test.com" });
      assert.deepEqual(updateResult, { email: "ana@test.com" });
    });

    it("rejects non-string attribute types", () => {
      assert.throws(() => {
        defineResource({
          modelName: "Legacy",
          attributes: {
            nombre: { type: { key: "STRING" } },
          },
        });
      }, /type must be a string/);
    });  });



    it("supports declarative attribute shorthand", async () => {
      const productoResource = defineResource({
        modelName: "Producto",
        tableName: "productos",
        attributes: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          descripcion: { type: "string", maxLength: 120, allowNull: false, title: "Nombre", max: 120 },
          precio: { type: "decimal", precision: 12, scale: 2, allowNull: false, defaultValue: 0, title: "Precio", min: 0 },
          activo: { type: "boolean", defaultValue: true, title: "Activo" },
        },
      });

      assert.equal(productoResource.attributes.descripcion.type.options.length, 120);
      assert.equal(productoResource.attributes.precio.type.options.precision, 12);
      assert.equal(productoResource.attributes.precio.type.options.scale, 2);

      const valid = await productoResource.schemas.create.validate({ descripcion: "Teclado", precio: 10 });
      assert.deepEqual(valid, { descripcion: "Teclado", precio: 10, activo: true });

      const invalid = await productoResource.schemas.create.validate({ precio: -1 }, { safe: true });
      assert.equal(invalid.errors.descripcion, "Nombre es requerido");
      assert.ok(invalid.errors.precio);
    });
  describe("module endpoints", () => {
    it("creates list/get/create/update/remove by default", () => {
      const mod = normalizeModule({ name: "items" });
      assert.deepEqual(Object.keys(mod.endpoints), ["list", "schema", "get", "create", "update", "remove"]);
      assert.equal(mod.endpoints.list.method, "get");
      assert.equal(mod.endpoints.schema.enabled, true);
      assert.equal(mod.endpoints.schema.path, "/schema");
      assert.equal(mod.endpoints.get.path, "/:id");
      assert.equal(mod.endpoints.create.method, "post");
      assert.equal(mod.endpoints.update.method, "put");
      assert.equal(mod.endpoints.remove.method, "delete");
    });

    it("joins global basePath with module basePath", () => {
      const mod = normalizeModule({ name: "items", basePath: "/items" }, { basePath: "/api" });
      assert.equal(mod.basePath, "/api/items");
    });

    it("allows disabling schema endpoint", () => {
      const mod = normalizeModule({ name: "items", schema: false });
      assert.equal(mod.endpoints.schema.enabled, false);
      assert.equal(mod.endpoints.schema.method, "get");
      assert.equal(mod.endpoints.schema.path, "/schema");
    });

    it("allows disabling default endpoints and adding custom endpoints", () => {
      const mod = normalizeModule({
        name: "items",
        endpoints: {
          remove: false,
          restore: { method: "post", path: "/:id/restore", permission: "items.restore" },
        },
      });

      assert.equal(mod.endpoints.remove.enabled, false);
      assert.equal(mod.endpoints.restore.enabled, true);
      assert.equal(mod.endpoints.restore.method, "post");
      assert.equal(mod.endpoints.restore.path, "/:id/restore");
      assert.equal(mod.endpoints.restore.permission, "items.restore");
    });
  });
    it("downloads validation schemas", async () => {
      const res = await request("GET", "/api/clientes/schema");
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.create.type, "object");
      assert.equal(res.body.data.create.properties.nombre.type, "string");
      assert.equal(res.body.data.create.properties.nombre.maxLength, 100);
      assert.deepEqual(res.body.data.create.required, ["nombre"]);
      assert.equal(res.body.data.update.properties.email.type, "string");
      assert.equal(res.body.data.update.properties.email.nullable, true);
      assert.equal(res.body.data.update.properties.email.format, "email");
      assert.equal(res.body.data.update.properties.email.maxLength, 150);
      assert.equal(res.body.data.create.properties.activo.type, "boolean");
      assert.equal(res.body.data.create.properties.activo.default, true);
    });

    it("downloads string and numeric metadata in validation schemas", async () => {
      const res = await request("GET", "/api/productos/schema");
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.create.properties.descripcion.title, "Nombre");
      assert.equal(res.body.data.create.properties.descripcion.maxLength, 120);
      assert.equal(res.body.data.create.properties.precio.title, "Precio");
      assert.equal(res.body.data.create.properties.precio.type, "number");
      assert.equal(res.body.data.create.properties.precio.precision, 12);
      assert.equal(res.body.data.create.properties.precio.scale, 2);
      assert.equal(res.body.data.create.properties.cantidad.precision, 8);
      assert.equal(res.body.data.create.properties.cantidad.scale, 3);
    });

    it("returns schema disabled when schema endpoint is disabled", async () => {
      const res = await request("GET", "/api/clientes-sin-schema/schema");
      assert.equal(res.status, 404);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, "SCHEMA_DISABLED");
      assert.equal(res.body.message, "Schema disabled");
    });

    it("downloads OpenAPI document for Postman import", async () => {
      const res = await request("GET", "/api/openapi.json");
      assert.equal(res.status, 200);
      assert.equal(res.body.openapi, "3.0.3");
      assert.equal(res.body.info.version, packageInfo.version);
      assert.deepEqual(res.body.servers, [{ url: "http://localhost:3000" }]);
      assert.ok(res.body.paths["/api/clientes"]);
      assert.ok(res.body.paths["/api/clientes/{id}"]);
      assert.ok(res.body.paths["/api/clientes"].get);
      assert.ok(res.body.paths["/api/clientes"].post);
      assert.equal(res.body.paths["/api/clientes"].post.requestBody.content["application/json"].schema.$ref, "#/components/schemas/clientes_create");
      assert.ok(res.body.components.schemas.clientes_create);
    });

  describe("CRUD - list", () => {
    it("returns empty list", async () => {
      const res = await request("GET", "/api/clientes");
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.ok(Array.isArray(res.body.data));
      assert.equal(res.body.pagination.page, 1);
      assert.equal(res.body.pagination.limit, 20);
      assert.equal(res.body.pagination.offset, 0);
      assert.equal(res.body.pagination.total, 0);
      assert.equal(res.body.pagination.pages, 0);
      assert.deepEqual(res.body.pagination.links, {
        self: "http://localhost:3001/api/clientes?page=1&limit=20",
        next: false,
        prev: false,
      });
    });

    it("supports page/limit", async () => {
      const res = await request("GET", "/api/clientes?page=1&limit=10");
      assert.equal(res.status, 200);
      assert.equal(res.body.pagination.limit, 10);
      assert.equal(res.body.pagination.offset, 0);
      assert.equal(res.body.pagination.links.self, "http://localhost:3001/api/clientes?page=1&limit=10");
    });
  });

  describe("CRUD - create", () => {
    it("creates a record", async () => {
      const res = await request("POST", "/api/clientes", {
        nombre: "Juan P�rez",
        email: "juan@test.com",
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.nombre, "Juan P�rez");
      assert.equal(typeof res.body.data.id, "number");
    });

    it("validates create body with yep schema", async () => {
      const res = await request("POST", "/api/clientes", {
        email: "no-es-email",
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, "VALIDATION_ERROR");
      assert.equal(res.body.errors.nombre, "Nombre es requerido");
      assert.ok(res.body.errors.email);
    });
  });

  describe("CRUD - get", () => {
    it("returns a record", async () => {
      const res = await request("GET", "/api/clientes/1");
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.nombre, "Juan P�rez");
    });

    it("returns 404 for missing record", async () => {
      const res = await request("GET", "/api/clientes/9999");
      assert.equal(res.status, 404);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, "NOT_FOUND");
      assert.equal(res.body.message, "Cliente no encontrado");
    });
  });

  describe("CRUD - update", () => {
    it("updates a record", async () => {
      const res = await request("PUT", "/api/clientes/1", {
        nombre: "Juan Actualizado",
        activo: false,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.nombre, "Juan Actualizado");
      assert.equal(res.body.data.activo, false);
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



























