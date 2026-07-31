import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Seq, SQLiteAdapter } from "seq";
import { BaseService, defineResource, ValidationError } from "../src/server/index.js";

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
      },
    });

    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, models: [productResource.model], logging: false });
    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    await productResource.model.create({ name: "Basic", email: "basic@test.com", price: 10, active: true });
    await productResource.model.create({ name: "Plus", email: "plus@test.com", price: 20, active: true });
    await productResource.model.create({ name: "Legacy", email: "legacy@test.com", price: 30, active: false });

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
    const result = await service.list({
      query: { page: "2", limit: "1", active: "true" },
      context: { baseUrl: "http://localhost/api/products?page=2&limit=1&active=true" },
    });

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

  it("maps nested query parser operator objects", async () => {
    const result = await service.list({ query: { price: { mayor: "10", menor: "30" } } });

    assert.equal(result.pagination.total, 1);
    assert.equal(result.data[0].name, "Plus");
  });

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

    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, models: [skuResource.model], logging: false });
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

    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, models: [skuResource.model], logging: false });
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

    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, models: [skuResource.model], logging: false });
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
    assert.equal((await skuResource.model.findByPk("SKU-2")).getDataValue("name"), "Renamed");
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

    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, models: [taskResource.model], logging: false });
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

  it("rejects unknown body fields instead of ignoring them", async () => {
    await assert.rejects(
      () => service.update({ params: { id: 1 }, body: { name: "Basic updated", activo: false } }),
      (error) =>
        error instanceof ValidationError &&
        error.message === "Datos inválidos, campo activo no permitido" &&
        error.errors?.activo === "Campo no permitido",
    );
  });

  it("rejects invalid typed filter values", async () => {
    await assert.rejects(
      () => service.list({ query: { "price[mayor]": "x" } }),
      (error) => error instanceof ValidationError && error.message === 'Filtro "price" debe ser number',
    );
  });

  it("rejects invalid typed in filter values", async () => {
    await assert.rejects(
      () => service.list({ query: { "price[in]": "10,x" } }),
      (error) => error instanceof ValidationError && error.message === 'Filtro "price" debe ser number',
    );
  });

  it("rejects range operators for boolean fields", async () => {
    await assert.rejects(
      () => service.list({ query: { "active[mayor]": "false" } }),
      (error) => error instanceof ValidationError && error.message === 'Filtro "active" no soporta operador "mayor"',
    );
  });

  it("maps unique constraint errors to field errors", async () => {
    await assert.rejects(
      () => service.create({ body: { name: "Duplicate", email: "basic@test.com", price: 40 } }),
      (error) =>
        error instanceof ValidationError &&
        error.message === "Valor duplicado" &&
        error.errors?.email === "Ya existe un registro con este valor",
    );
  });
});

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

    const adapter = new SQLiteAdapter({ database: ":memory:" });
    seq = new Seq({ adapter, models: [ventaResource.model, itemResource.model, cobroResource.model], logging: false });
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

  it("rolls back the master when a detail is invalid", async () => {
    await assert.rejects(
      () =>
        service.create({
          body: {
            cliente: "Ana",
            total: 150,
            items: [{ producto: "Mouse" }],
          },
        }),
      ValidationError,
    );

    assert.equal(await ventaResource.model.count(), 0);
    assert.equal(await itemResource.model.count(), 0);
  });

  it("upserts sent details and keeps omitted details by default", async () => {
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

    const firstItem = created.data.items[0];
    const updated = await service.update({
      params: { id: created.data.id },
      body: {
        cliente: "Ana Maria",
        items: [
          { id: firstItem.id, producto: "Mouse gamer", cantidad: 3 },
          { producto: "Monitor", cantidad: 1 },
        ],
      },
    });

    assert.equal(updated.data.cliente, "Ana Maria");
    assert.equal(updated.data.items.length, 3);
    assert.ok(updated.data.items.some((item) => item.producto === "Mouse gamer" && item.cantidad === 3));
    assert.ok(updated.data.items.some((item) => item.producto === "Teclado"));
    assert.ok(updated.data.items.some((item) => item.producto === "Monitor"));
  });

  it("removes omitted details when removeMissing is true", async () => {
    service = new BaseService({
      model: ventaResource.model,
      schemas: ventaResource.schemas,
      seq,
      config: {
        resource: ventaResource,
        details: {
          items: { association: "items", removeMissing: true },
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

    const firstItem = created.data.items[0];
    const updated = await service.update({
      params: { id: created.data.id },
      body: {
        items: [{ id: firstItem.id, producto: "Mouse", cantidad: 5 }],
      },
    });

    assert.equal(updated.data.items.length, 1);
    assert.equal(updated.data.items[0].cantidad, 5);
    assert.equal(await itemResource.model.count(), 1);
  });

  it("creates, updates, and removes individual details through generic methods", async () => {
    const created = await service.create({ body: { cliente: "Ana", total: 0 } });
    const detail = await service.createDetail({
      params: { id: created.data.id, detail: "items" },
      body: { producto: "Mouse", cantidad: 1 },
    });

    const updated = await service.updateDetail({
      params: { id: created.data.id, detail: "items", detailId: detail.data.id },
      body: { producto: "Mouse", cantidad: 4 },
    });

    assert.equal(updated.data.cantidad, 4);

    await service.removeDetail({
      params: { id: created.data.id, detail: "items", detailId: detail.data.id },
    });

    assert.equal(await itemResource.model.count(), 0);
  });
});
