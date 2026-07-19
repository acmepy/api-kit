import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Seq, SQLiteAdapter } from "seq";
import { createApiKit } from "../src/index.js";

const modules = [
  {
    modelName: "Cliente",
    tableName: "clientes",
    timestamps: true,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      nombre: { type: "string", allowNull: false },
      activo: { type: "boolean", defaultValue: true },
    },
  },
  {
    modelName: "Producto",
    tableName: "productos",
    timestamps: true,
    audit: false,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      descripcion: { type: "string", allowNull: false },
    },
  },
  {
    modelName: "audit",
    tableName: "audit",
    timestamps: true,
    audit: false,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      txId: { type: "string", maxLength: 50, allowNull: false },
      clientIp: { type: "string", maxLength: 50, allowNull: false },
      userId: { type: "string", maxLength: 20 },
      tableName: { type: "string", maxLength: 50, allowNull: false },
      rowId: { type: "string", maxLength: 50, allowNull: false },
      action: { type: "string", maxLength: 20, allowNull: false },
      old: { type: "json" },
      new: { type: "json" },
    },
  },
];

describe("audit", () => {
  it("audits enabled modules and skips disabled/audit modules", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({ seq, audit: true, modules });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const cliente = await api.services.get("clientes").create({ body: { nombre: "Ana" } });
    await api.services.get("clientes").update({ params: { id: cliente.data.id }, body: { activo: false } });
    await api.services.get("productos").create({ body: { descripcion: "Mouse" } });

    const Audit = api.models.get("audit");
    const rows = await Audit.findAll({ order: [["id", "ASC"]] });

    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.getDataValue("action")), ["create", "update"]);
    assert.deepEqual(rows.map((row) => row.getDataValue("tableName")), ["clientes", "clientes"]);
    assert.equal(rows[0].getDataValue("new").nombre, "Ana");
    assert.equal(rows[1].getDataValue("old").activo, true);
    assert.equal(rows[1].getDataValue("new").activo, false);
  });
});
