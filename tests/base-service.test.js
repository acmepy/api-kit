import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Seq, SQLiteAdapter } from "seq";
import { BaseService, defineResource, ValidationError } from "../src/index.js";

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
        price: { type: "decimal", precision: 12, scale: 2, allowNull: false },
        active: { type: "boolean", defaultValue: true },
      },
    });

    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, models: [productResource.model], logging: false });
    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    await productResource.model.create({ name: "Basic", price: 10, active: true });
    await productResource.model.create({ name: "Plus", price: 20, active: true });
    await productResource.model.create({ name: "Legacy", price: 30, active: false });

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
});
