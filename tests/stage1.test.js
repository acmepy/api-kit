import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import packageInfo from "../package.json" with { type: "json" };
import yep from "yep";
import { createApiKit, defineResource } from "../src/server/index.js";
import { getContext } from "../src/server/index.js";
import { normalizeModule } from "../src/server/config/config-normalizer.js";
import { Seq, SQLiteAdapter, DataTypes } from "seq";

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
    postman: true,
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

describe("Etapa 1 - Nucleo", () => {
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
      }, /type must be a string or seq DataType/);
    });

    it("supports seq virtual attributes in declarative modules", async () => {
      const personResource = defineResource({
        modelName: "Person",
        tableName: "people",
        timestamps: false,
        attributes: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          firstName: { type: "string", allowNull: false },
          lastName: { type: "string", allowNull: false },
          fullName: {
            type: DataTypes.VIRTUAL(DataTypes.STRING(200), ["firstName", "lastName"]),
            get() {
              return `${this.get("firstName")} ${this.get("lastName")}`;
            },
          },
        },
      });

      assert.equal(personResource.attributes.fullName.type.key, "VIRTUAL");
      assert.equal(typeof personResource.attributes.fullName.get, "function");
      assert.equal(personResource.schemas.create.shapeDefinition.fullName, undefined);
      assert.equal(personResource.schemas.update.shapeDefinition.fullName, undefined);

      const adapter = new SQLiteAdapter({ database: ":memory:" });
      const seq = new Seq({ adapter, models: [personResource.model], logging: false });
      await seq.authenticate();
      await seq.init();
      await seq.sync({ force: true });

      const schema = adapter.schemas.get("people");
      assert.equal(schema.columns.fullName, undefined);
      assert.deepEqual(schema.virtualAttributes, ["fullName"]);

      const person = await personResource.model.create({ firstName: "Ada", lastName: "Lovelace" });
      assert.equal(person.toJSON().fullName, "Ada Lovelace");
      await seq.close();
    });  });



    it("supports declarative attribute shorthand", async () => {
      const productoResource = defineResource({
        modelName: "Producto",
        tableName: "productos",
        attributes: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          descripcion: { type: "string", maxLength: 120, allowNull: false, title: "Nombre", max: 120 },
          precio: { type: "decimal", precision: 12, scale: 2, allowNull: false, defaultValue: 0, title: "Precio", min: 0 },
          tags: { type: "array", itemType: "string" },
          activo: { type: "boolean", defaultValue: true, title: "Activo" },
        },
      });

      assert.equal(productoResource.attributes.descripcion.type.options.length, 120);
      assert.equal(productoResource.attributes.precio.type.options.precision, 12);
      assert.equal(productoResource.attributes.precio.type.options.scale, 2);
      assert.equal(productoResource.attributes.tags.type.key, "ARRAY");
      assert.equal(productoResource.attributes.tags.type.options.itemType.key, "STRING");

      const valid = await productoResource.schemas.create.validate({ descripcion: "Teclado", precio: 10, tags: ["periferico"] });
      assert.deepEqual(valid, { descripcion: "Teclado", precio: 10, tags: ["periferico"], activo: true });

      const invalid = await productoResource.schemas.create.validate({ precio: -1 }, { safe: true });
      assert.equal(invalid.errors.descripcion, "Nombre es requerido");
      assert.ok(invalid.errors.precio);
    });
    it("supports yep validation rules in declarative attributes", async () => {
      const rulesResource = defineResource({
        modelName: "RuleExample",
        requiredOneOf: ["email", "telefono"],
        attributes: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          codigo: { type: "string", title: "Codigo", required: true, in: ["A", "B"], pattern: /^[AB]$/, default: "A" },
          nombre: { type: "string", title: "Nombre", min: 3, maxLength: 8 },
          email: { type: "string", title: "Email", nullable: true, email: true, notOneOf: ["blocked@test.com"] },
          telefono1: { type: "string", title: "Telefono", matches: /^09\d{8}$/ },
          telefono2: { type: "string", title: "Telefono", pattern: /^09\d{8}$/ },
          telefono3: { type: "string", title: "Telefono", regex: /^09\d{8}$/ },
          edad: { type: "integer", title: "Edad", positive: true, between: [1, 120] },
        },
      });

      const valid = await rulesResource.schemas.create.validate({
        nombre: "Cliente",
        telefono: "0981123456",
        edad: 30,
      });
      assert.equal(valid.codigo, "A");

      const invalid = await rulesResource.schemas.create.validate({
        codigo: "C",
        nombre: "AB",
        email: "blocked@test.com",
        telefono1: "123",
        telefono2: "123",
        telefono3: "123",
        edad: 0,
      }, { safe: true });
      assert.ok(invalid.errors.codigo);
      assert.ok(invalid.errors.nombre);
      assert.ok(invalid.errors.email);
      //assert.ok(invalid.errors.telefono);
      assert.ok(invalid.errors.edad);

      const missingContact = await rulesResource.schemas.create.validate({ codigo: "A", nombre: "Cliente", edad: 20 }, { safe: true });
      assert.ok(missingContact.errors.email);
      assert.ok(missingContact.errors.telefono);
    });

    it("supports custom yep validation methods in declarative attributes", async () => {
      if (typeof yep.string().rucDeclarativoTest !== "function") {
        yep.addTest("rucDeclarativoTest", (value) => value === undefined || /^\d+-\d$/.test(value), {
          message: ({ title }) => `${title} no tiene un formato valido`,
        });
      }

      const rucResource = defineResource({
        modelName: "RucExample",
        attributes: {
          ruc: { type: "string", title: "RUC", rucDeclarativoTest: true },
        },
      });

      assert.deepEqual(await rucResource.schemas.create.validate({ ruc: "123-4" }), { ruc: "123-4" });
      const invalid = await rucResource.schemas.create.validate({ ruc: "abc" }, { safe: true });
      assert.equal(invalid.errors.ruc, "RUC no tiene un formato valido");
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
      //assert.equal(res.body.data.create.properties.precio.precision, 12);
      //assert.equal(res.body.data.create.properties.precio.scale, 2);
      //assert.equal(res.body.data.create.properties.cantidad.precision, 8);
      //assert.equal(res.body.data.create.properties.cantidad.scale, 3);
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
      assert.deepEqual(res.body.paths["/api/clientes"].get.tags, ["clientes"]);
      assert.deepEqual(res.body.paths["/api/clientes"].post.tags, ["clientes"]);
      assert.deepEqual(res.body.paths["/api/clientes/{id}"].get.tags, ["clientes"]);
      assert.deepEqual(res.body.paths["/api/clientes/schema"].get.tags, ["clientes"]);
      assert.equal(res.body.paths["/api/clientes"].get.operationId, "clientes_list");
      assert.equal(res.body.paths["/api/clientes/{id}"].get.operationId, "clientes_get");
      assert.equal(res.body.paths["/api/clientes/schema"].get.operationId, "clientes_schema");
      assert.notDeepEqual(res.body.paths["/api/clientes"].get.tags, ["Clientes"]);
      assert.equal(res.body.paths["/api/clientes"].post.requestBody.content["application/json"].schema.$ref, "#/components/schemas/clientes_create");
      assert.ok(res.body.components.schemas.clientes_create);
      assert.equal(res.body.components.schemas.clientes_create.properties.nombre.maxLength, 100);
      assert.equal(res.body.components.schemas.clientes_update.properties.email.maxLength, 150);
    });

    it("downloads Postman collection with module folders", async () => {
      const res = await request("GET", "/api/postman.json");
      assert.equal(res.status, 200);
      assert.equal(res.body.info.schema, "https://schema.getpostman.com/json/collection/v2.1.0/collection.json");
      assert.match(res.body.info.description, /Use el request Login para obtener el token/);
      assert.match(res.body.info.description, /actualiza automaticamente la variable bearerToken/);
      assert.match(res.body.info.description, /Use el request Logout/);
      assert.match(res.body.info.description, /limpiar bearerToken/);
      assert.equal(res.body.variable.find((item) => item.key === "baseUrl").value, "http://localhost:3000");

      const root = res.body.item.find((item) => item.name === "api");
      const welcome = root.item.find((item) => item.name === "Backend welcome");
      assert.ok(welcome);
      assert.equal(welcome.request.method, "GET");
      assert.equal(welcome.request.url.raw, "{{baseUrl}}/api");
      assert.equal(root.item.find((item) => item.name === "system"), undefined);

      const clientes = root.item.find((item) => item.name === "clientes");
      assert.ok(clientes);
      assert.deepEqual(clientes.item.map((item) => item.name), ["Listar", "Schema", "Obtener por ID", "Crear", "Actualizar", "Eliminar"]);

      const getById = clientes.item.find((item) => item.name === "Obtener por ID");
      assert.equal(getById.request.method, "GET");
      assert.equal(getById.request.url.raw, "{{baseUrl}}/api/clientes/:id");
      assert.deepEqual(getById.request.url.variable, [{ key: "id", value: "string" }]);

      const create = clientes.item.find((item) => item.name === "Crear");
      assert.equal(create.request.method, "POST");
      assert.equal(create.request.body.mode, "raw");
      assert.deepEqual(JSON.parse(create.request.body.raw), {
        nombre: "string",
        email: "user@example.com",
        activo: true,
      });
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
        nombre: "Juan Pï¿½rez",
        email: "juan@test.com",
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.nombre, "Juan Pï¿½rez");
      assert.equal(typeof res.body.data.id, "number");
    });

    it("validates create body with yep schema", async () => {
      const res = await request("POST", "/api/clientes", {
        email: "no-es-email",
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, "VALIDATION_ERROR");
      assert.equal(res.body.message, "Se han producido 2 errores");
      assert.equal(res.body.errors.nombre, "Nombre es requerido");
      assert.ok(res.body.errors.email);
    });
  });

  describe("CRUD - get", () => {
    it("returns a record", async () => {
      const res = await request("GET", "/api/clientes/1");
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.nombre, "Juan Pï¿½rez");
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






























