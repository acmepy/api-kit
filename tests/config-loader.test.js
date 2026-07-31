import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadModules } from "../src/server/config/config-loader.js";

describe("loadModules", () => {
  it("converts resource definitions to module configs", async () => {
    const modules = await loadModules(
      {
        modelName: "Cliente",
        tableName: "clientes",
        attributes: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          nombre: { type: "string", allowNull: false },
        },
      },
      process.cwd(),
    );

    assert.equal(modules.length, 1);
    assert.equal(modules[0].name, "clientes");
    assert.equal(modules[0].resource.options.modelName, "Cliente");
    assert.ok(modules[0].resource.schemas.create);
  });

  it("converts inline detail definitions to associations and detail config", async () => {
    const modules = await loadModules(
      {
        modelName: "Venta",
        tableName: "ventas",
        attributes: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          cliente: { type: "string", allowNull: false },
        },
        details: [
          {
            modelName: "VentaItem",
            tableName: "venta_items",
            attributes: {
              id: { type: "integer", primaryKey: true, autoIncrement: true },
              ventaId: { type: "integer", allowNull: false, create: false, update: false },
              producto: { type: "string", allowNull: false },
            },
            removeMissing: true,
          },
        ],
      },
      process.cwd(),
    );

    assert.equal(modules.length, 1);
    assert.equal(modules[0].name, "ventas");
    assert.deepEqual(modules[0].details, { items: { association: "items", removeMissing: true } });
    assert.equal(modules[0].detailResources.length, 1);
    assert.equal(modules[0].resource.model.associations.items.target, modules[0].detailResources[0].model);
    assert.equal(modules[0].resource.model.associations.items.foreignKey, "ventaId");
  });
});
