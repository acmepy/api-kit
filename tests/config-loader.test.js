import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadModules } from "../src/config/config-loader.js";

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
});
