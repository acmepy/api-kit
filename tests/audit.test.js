import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
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

  it("exposes audit changes since a date", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({ seq, basePath: "/api", audit: true, modules });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const since = new Date(Date.now() - 1000).toISOString();
      await api.services.get("clientes").create({ body: { nombre: "Ana" } });

      const res = await request(server, "GET", `/api/changes?since=${encodeURIComponent(since)}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].action, "create");
      assert.equal(res.body.data[0].tableName, "clientes");
      assert.equal(res.body.data[0].new.nombre, "Ana");

      const invalid = await request(server, "GET", "/api/changes");
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.errors.since, "Requerido");
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

function request(server, method, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "localhost", port, path, method }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {}
        resolve({ status: res.statusCode, body, raw });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
