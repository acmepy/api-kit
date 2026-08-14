import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestSeq } from "./helpers/seq.js";
import { BaseService, defineResource, NotFoundError, ValidationError, runWithContext } from "../src/server/index.js";

describe("BaseService list filters", () => {
  let service;

  beforeEach(async () => {
    const productResource = defineResource({
      modelName: "Product",
      tableName: "products",
      timestamps: false,
      attributes: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        name: { type: "string", allowNull: false },
        email: { type: "string", allowNull: false, unique: true },
        price: { type: "decimal", precision: 12, scale: 2, allowNull: false },
        active: { type: "boolean", defaultValue: true },
        created_at: { type: "string" },
      },
    });

    const seq = createTestSeq({ models: [productResource.model], logging: false });
    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    await productResource.model.create({ name: "Basic", email: "basic@test.com", price: 10, active: true, created_at: "2026-01-01" });
    await productResource.model.create({ name: "Plus", email: "plus@test.com", price: 20, active: true, created_at: "2026-06-01" });
    await productResource.model.create({ name: "Legacy", email: "legacy@test.com", price: 30, active: false, created_at: "2025-01-01" });

    service = new BaseService({
      model: productResource.model,
      schemas: productResource.schemas,
      config: { resource: productResource },
    });
  });

  it("keeps plain query filters as typed equality", async () => {
    const result = await service.list({ query: { active: "true" } });

    assert.equal(result.pagination.total, 2);
    assert.deepEqual(result.data.map((item) => item.name), ["Basic", "Plus"]);
  });

  it("returns limit and offset pagination metadata", async () => {
    const result = await service.list({ query: { page: "2", limit: "1" } });

    assert.equal(result.pagination.page, 2);
    assert.equal(result.pagination.limit, 1);
    assert.equal(result.pagination.offset, 1);
    assert.equal(result.pagination.total, 3);
    assert.equal(result.pagination.pages, 3);
  });

  it("adds pagination links when baseUrl is available", async () => {
    const result = await runInRequestContext({
      originalUrl: "/api/products?page=2&limit=1&active=true",
    }, () => service.list({
      query: { page: "2", limit: "1", active: "true" },
    }));

    assert.deepEqual(result.pagination.links, {
      self: "http://localhost/api/products?page=2&limit=1&active=true",
      next: false,
      prev: "http://localhost/api/products?page=1&limit=1&active=true",
    });
  });

  it("maps greater and less operators", async () => {
    const result = await service.list({ query: { "price[mayor]": "10", "price[menor]": "30" } });

    assert.equal(result.pagination.total, 1);
    assert.equal(result.data[0].name, "Plus");
  });

  it("maps between operator", async () => {
    const result = await service.list({ query: { "price[between]": "10,20" } });

    assert.equal(result.pagination.total, 2);
    assert.deepEqual(result.data.map((item) => item.name), ["Basic", "Plus"]);
  });

  it("maps in operator", async () => {
    const result = await service.list({ query: { "name[in]": "Basic,Legacy" } });

    assert.equal(result.pagination.total, 2);
    assert.deepEqual(result.data.map((item) => item.name), ["Basic", "Legacy"]);
  });

  it("casts in operator values by field type", async () => {
    const result = await service.list({ query: { "price[in]": "10,30" } });

    assert.equal(result.pagination.total, 2);
    assert.deepEqual(result.data.map((item) => item.name), ["Basic", "Legacy"]);
  });

  it("filters correctly with snake_case attributes and operators", async () => {
    const result = await service.list({ query: { "created_at[gte]": "2026-01-01" } });

    assert.equal(result.pagination.total, 2);
    assert.deepEqual(result.data.map((item) => item.name), ["Basic", "Plus"]);
  });

  /*it("maps nested query parser operator objects", async () => {
    const result = await service.list({ query: { price: { mayor: "10", menor: "30" } } });

    assert.equal(result.pagination.total, 1);
    assert.equal(result.data[0].name, "Plus");
  });*/

  it("updates boolean false values", async () => {
    const result = await service.update({
      params: { id: 1 },
      body: { name: "Basic updated", active: false },
    });

    assert.equal(result.data.name, "Basic updated");
    assert.equal(result.data.active, false);
  });

  it("updates a record partially without requiring every field", async () => {
    const result = await service.update({
      params: { id: 1 },
      body: { name: "Basic renamed" },
    });

    assert.equal(result.data.name, "Basic renamed");
    assert.equal(result.data.email, "basic@test.com");
    assert.equal(Number(result.data.price), 10);
    assert.equal(result.data.active, true);
  });

  it("omits autoincrement primary key values from create bodies", async () => {
    const result = await service.create({
      body: { id: 99, name: "Generated", email: "generated@test.com", price: 50 },
    });

    assert.notEqual(result.data.id, 99);
    assert.equal(result.data.name, "Generated");
  });

  it("keeps non autoincrement primary key values in create bodies", async () => {
    const skuResource = defineResource({
      modelName: "CreateSku",
      tableName: "create_skus",
      timestamps: false,
      attributes: {
        id: { type: "string", primaryKey: true },
        name: { type: "string", allowNull: false },
      },
    });

    const seq = createTestSeq({ models: [skuResource.model], logging: false });
    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const skuService = new BaseService({
      model: skuResource.model,
      schemas: skuResource.schemas,
      config: { resource: skuResource },
    });

    const result = await skuService.create({
      body: { id: "SKU-1", name: "Created" },
    });

    assert.equal(result.data.id, "SKU-1");
    assert.equal(result.data.name, "Created");
  });

  it("omits primary key values from update bodies by default", async () => {
    const result = await service.update({
      params: { id: 1 },
      body: { id: 99, name: "Basic with ignored id" },
    });

    assert.equal(result.data.id, 1);
    assert.equal(result.data.name, "Basic with ignored id");
  });

  it("omits update false fields from update bodies", async () => {
    const skuResource = defineResource({
      modelName: "Sku",
      tableName: "skus",
      timestamps: false,
      attributes: {
        id: { type: "string", primaryKey: true, update: false },
        name: { type: "string", allowNull: false },
      },
    });

    const seq = createTestSeq({ models: [skuResource.model], logging: false });
    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    await skuResource.model.create({ id: "SKU-1", name: "Original" });
    const skuService = new BaseService({
      model: skuResource.model,
      schemas: skuResource.schemas,
      config: { resource: skuResource },
    });

    const result = await skuService.update({
      params: { id: "SKU-1" },
      body: { id: "SKU-2", name: "Renamed" },
    });

    assert.equal(result.data.id, "SKU-1");
    assert.equal(result.data.name, "Renamed");
    assert.equal(await skuResource.model.findByPk("SKU-2"), null);
  });

  it("allows primary key updates when the attribute declares update true", async () => {
    const skuResource = defineResource({
      modelName: "MutableSku",
      tableName: "mutable_skus",
      timestamps: false,
      attributes: {
        id: { type: "string", primaryKey: true, update: true },
        name: { type: "string", allowNull: false },
      },
    });

    const seq = createTestSeq({ models: [skuResource.model], logging: false });
    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    await skuResource.model.create({ id: "SKU-1", name: "Original" });
    const skuService = new BaseService({
      model: skuResource.model,
      schemas: skuResource.schemas,
      config: { resource: skuResource },
    });

    const result = await skuService.update({
      params: { id: "SKU-1" },
      body: { id: "SKU-2", name: "Renamed" },
    });

    assert.equal(result.data.id, "SKU-2");
    assert.equal(result.data.name, "Renamed");
    assert.equal(await skuResource.model.findByPk("SKU-1"), null);
    assert.equal((await skuResource.model.findByPk("SKU-2")).get("name"), "Renamed");
  });

  it("validates date strings through yep schemas", async () => {
    const taskResource = defineResource({
      modelName: "Task",
      tableName: "tasks",
      timestamps: false,
      attributes: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        name: { type: "string", allowNull: false },
        dueAt: { type: "date", allowNull: false },
      },
    });

    const seq = createTestSeq({ models: [taskResource.model], logging: false });
    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const taskService = new BaseService({
      model: taskResource.model,
      schemas: taskResource.schemas,
      config: { resource: taskResource },
    });

    const result = await taskService.create({
      body: { name: "Release", dueAt: "2026-07-28T10:00:00.000Z" },
    });

    assert.equal(result.data.name, "Release");
    assert.equal(new Date(result.data.dueAt).toISOString(), "2026-07-28T10:00:00.000Z");
  });

  it("ignores unknown update body fields through the update schema", async () => {
    const result = await service.update({ params: { id: 1 }, body: { name: "Basic updated", activo: false } });

    assert.equal(result.data.name, "Basic updated");
    assert.equal(result.data.active, true);
  });

  it("rejects invalid typed filter values", async () => {
    await assert.rejects(
      () => service.list({ query: { "price[mayor]": "x" } }),
      (error) => error.name === "ValidationError" && error.message === "Price debe ser de tipo number",
    );
  });

  it("rejects invalid typed in filter values", async () => {
    await assert.rejects(
      () => service.list({ query: { "price[in]": "10,x" } }),
      (error) => error.name === "ValidationError" && error.message === "Price debe ser de tipo number",
    );
  });

  it("rejects range operators for boolean fields", async () => {
    await assert.rejects(
      () => service.list({ query: { "active[mayor]": "false" } }),
      (error) => error instanceof ValidationError && error.message === 'Filtro "active" no soporta operador "mayor"',
    );
  });

  it("returns seq unique constraint errors directly", async () => {
    await assert.rejects(
      () => service.create({ body: { name: "Duplicate", email: "basic@test.com", price: 40 } }),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, "CONFLICT");
        assert.deepEqual(error.errors, { email: "Ya existe un registro con este valor" });
        assert.equal(error.details.constraint.type, "unique");
        return true;
      },
    );
  });
});

function runInRequestContext(reqOverrides, callback) {
  const req = {
    headers: {},
    ip: "127.0.0.1",
    protocol: "http",
    originalUrl: "/",
    socket: {},
    get(name) {
      return name.toLowerCase() === "host" ? "localhost" : undefined;
    },
    ...reqOverrides,
  };

  return new Promise((resolve, reject) => {
    runWithContext(req, {}, () => {
      Promise.resolve(callback()).then(resolve, reject);
    });
  });
}

describe("BaseService details", () => {
  let seq;
  let ventaResource;
  let itemResource;
  let cobroResource;
  let service;

  beforeEach(async () => {
    ventaResource = defineResource({
      modelName: "Venta",
      tableName: "ventas",
      timestamps: false,
      attributes: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        cliente: { type: "string", allowNull: false },
        total: { type: "decimal", precision: 12, scale: 2, allowNull: false, defaultValue: 0 },
      },
    });

    itemResource = defineResource({
      modelName: "VentaItem",
      tableName: "venta_items",
      timestamps: false,
      attributes: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        ventaId: { type: "integer", allowNull: false },
        producto: { type: "string", allowNull: false },
        cantidad: { type: "integer", allowNull: false },
      },
    });

    cobroResource = defineResource({
      modelName: "VentaCobro",
      tableName: "venta_cobros",
      timestamps: false,
      attributes: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        ventaId: { type: "integer", allowNull: false },
        medio: { type: "string", allowNull: false },
        monto: { type: "decimal", precision: 12, scale: 2, allowNull: false },
      },
    });

    ventaResource.model.hasMany(itemResource.model, { as: "items", foreignKey: "ventaId" });
    itemResource.model.belongsTo(ventaResource.model, { as: "venta", foreignKey: "ventaId" });
    ventaResource.model.hasMany(cobroResource.model, { as: "cobros", foreignKey: "ventaId" });
    cobroResource.model.belongsTo(ventaResource.model, { as: "venta", foreignKey: "ventaId" });

    seq = createTestSeq({ models: [ventaResource.model, itemResource.model, cobroResource.model], logging: false });
    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    service = new BaseService({
      model: ventaResource.model,
      schemas: ventaResource.schemas,
      seq,
      config: {
        resource: ventaResource,
        details: {
          items: { association: "items" },
          cobros: { association: "cobros" },
        },
      },
    });
  });

  it("creates a master record with multiple details in one call", async () => {
    const result = await service.create({
      body: {
        cliente: "Ana",
        total: 150,
        items: [
          { producto: "Mouse", cantidad: 1 },
          { producto: "Teclado", cantidad: 2 },
        ],
        cobros: [{ medio: "efectivo", monto: 150 }],
      },
    });

    assert.equal(result.data.cliente, "Ana");
    assert.equal(result.data.items.length, 2);
    assert.equal(result.data.cobros.length, 1);
    assert.equal(result.data.items[0].ventaId, result.data.id);
    assert.equal(await itemResource.model.count(), 2);
    assert.equal(await cobroResource.model.count(), 1);
  });

  it("returns plain objects for included details when reloading a master record", async () => {
    const result = await service.create({
      body: {
        cliente: "Ana",
        total: 150,
        items: [{ producto: "Mouse", cantidad: 1 }],
      },
    });

    assert.equal(result.data.items[0].constructor.name, "Object");
    assert.equal(result.data.items[0].dataValues, undefined);
    assert.equal(result.data.items[0].producto, "Mouse");
    assert.equal(result.data.items[0].ventaId, result.data.id);
  });

  it("rolls back the master when seq rejects an invalid detail", async () => {
    await assert.rejects(
      () =>
        service.create({
          body: {
            cliente: "Ana",
            total: 150,
            items: [{ producto: "Mouse" }],
          },
        }),
      (error) =>
        error.name === "ValidationError" &&
        error.message === 'Field "cantidad" does not allow null values in model "VentaItem"',
    );

    assert.equal(await ventaResource.model.count(), 0);
    assert.equal(await itemResource.model.count(), 0);
  });

  it("replaces details on update using seq native include handling", async () => {
    const created = await service.create({
      body: {
        cliente: "Ana",
        total: 150,
        items: [
          { producto: "Mouse", cantidad: 1 },
          { producto: "Teclado", cantidad: 2 },
        ],
      },
    });

    const updated = await service.update({
      params: { id: created.data.id },
      body: {
        cliente: "Ana Maria",
        items: [
          { producto: "Mouse gamer", cantidad: 3 },
          { producto: "Monitor", cantidad: 1 },
        ],
      },
    });

    assert.equal(updated.data.cliente, "Ana Maria");
    assert.equal(updated.data.items.length, 2);
    assert.ok(updated.data.items.some((item) => item.producto === "Mouse gamer" && item.cantidad === 3));
    assert.ok(updated.data.items.some((item) => item.producto === "Monitor"));
    assert.equal(updated.data.items.some((item) => item.producto === "Teclado"), false);
    assert.equal(await itemResource.model.count(), 2);
  });

  it("creates replacement details on update without explicit foreign keys", async () => {
    service = new BaseService({
      model: ventaResource.model,
      schemas: ventaResource.schemas,
      seq,
      config: {
        resource: ventaResource,
        details: {
          items: { association: "items" },
        },
      },
    });

    const created = await service.create({
      body: {
        cliente: "Ana",
        total: 150,
        items: [
          { producto: "Mouse", cantidad: 1 },
          { producto: "Teclado", cantidad: 2 },
        ],
      },
    });

    const updated = await service.update({
      params: { id: created.data.id },
      body: {
        items: [{ producto: "Mouse", cantidad: 5 }],
      },
    });

    assert.equal(updated.data.items.length, 1);
    assert.equal(updated.data.items[0].cantidad, 5);
    assert.equal(updated.data.items[0].ventaId, created.data.id);
    assert.equal(await itemResource.model.count(), 1);
  });

  it("creates, updates, and removes individual details through seq methods", async () => {
    const created = await service.create({ body: { cliente: "Ana", total: 0 } });
    const detail = await service.createDetail({
      params: { id: created.data.id, detail: "items" },
      body: { ventaId: created.data.id, producto: "Mouse", cantidad: 1 },
    });

    assert.equal(detail.data.ventaId, created.data.id);

    const updated = await service.updateDetail({
      params: { id: created.data.id, detail: "items", detailId: detail.data.id },
      body: { producto: "Mouse", cantidad: 4 },
    });

    assert.equal(updated.data.cantidad, 4);
    assert.equal(await itemResource.model.count(), 1);

    await assert.rejects(
      () =>
        service.updateDetail({
          params: { id: created.data.id, detail: "items", detailId: 9999 },
          body: { producto: "Ghost", cantidad: 1 },
        }),
      NotFoundError,
    );
    assert.equal(await itemResource.model.count(), 1);

    const other = await service.create({ body: { cliente: "Beto", total: 0 } });
    await assert.rejects(
      () =>
        service.updateDetail({
          params: { id: other.data.id, detail: "items", detailId: detail.data.id },
          body: { producto: "Otro", cantidad: 2 },
        }),
      NotFoundError,
    );

    const removed = await service.removeDetail({
      params: { id: created.data.id, detail: "items", detailId: detail.data.id },
    });

    assert.equal(removed.data.producto, "Mouse");
    assert.equal(await itemResource.model.count(), 0);

    await assert.rejects(
      () =>
        service.removeDetail({
          params: { id: other.data.id, detail: "items", detailId: detail.data.id },
        }),
      NotFoundError,
    );
  });
});
