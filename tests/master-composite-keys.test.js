import { it } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../src/server/index.js";
import { createTestSeq } from "./helpers/seq.js";

it("master composite keys: CRUD isolates branches and rejects incomplete or changed keys", async () => {
  const seq = createTestSeq({ logging: false });
  const api = await createApi({ seq, basePath: "/api", modules: [{
    name: "parametros", modelName: "Parametros", timestamps: false,
    attributes: {
      id: { type: "integer", primaryKey: true },
      codSucursal: { type: "string", primaryKey: true },
      valor: { type: "string", allowNull: false },
      referencia: { type: "string", unique: true },
    },
  }] });
  await seq.authenticate();
  await seq.init();
  await seq.sync({ force: true });
  const server = await new Promise(resolve => {
    const listener = api.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const request = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/parametros${path}`, {
      method, headers: { "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const service = api.services.get("parametros");
  const model = service.model;
  try {
    for (const codSucursal of ["001", "002"]) {
      const result = await request("POST", "", { id: 1, codSucursal, valor: codSucursal, referencia: codSucursal });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    const get = await request("GET", "/1?codSucursal=001");
    assert.equal(get.status, 200, JSON.stringify(get.body));
    assert.equal(get.body.data.codSucursal, "001");
    const sameUnique = await request("PUT", "/1?codSucursal=001", { referencia: "001" });
    assert.equal(sameUnique.status, 200, JSON.stringify(sameUnique.body));
    const duplicateUnique = await request("PUT", "/1?codSucursal=001", { referencia: "002" });
    assert.equal(duplicateUnique.status, 400, JSON.stringify(duplicateUnique.body));
    const changed = await request("PUT", "/1?codSucursal=001", { valor: "nuevo" });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.data.valor, "nuevo");
    assert.equal((await model.findByPk({ id: 1, codSucursal: "002" })).get("valor"), "002");
    for (const method of ["GET", "PUT", "DELETE"]) {
      for (const path of ["/1", "/1?codSucursal=", "/1?codSucursal=001&codSucursal=002"]) {
        assert.equal((await request(method, path, method === "PUT" ? { valor: "incorrecto" } : undefined)).status, 400);
      }
      assert.equal((await request(method, "/1?codSucursal=999", method === "PUT" ? { valor: "incorrecto" } : undefined)).status, 404);
    }
    for (const body of [{ codSucursal: "002" }, { id: 2 }]) {
      assert.equal((await request("PUT", "/1?codSucursal=001", body)).status, 400);
    }
    const direct = await service.get({ params: { id: { id: 1, codSucursal: "001" } } });
    assert.equal(direct.data.valor, "nuevo");
    const updated = await service.update({ params: { id: { id: 1, codSucursal: "001" } }, body: { valor: "directo" } });
    assert.equal(updated.data.valor, "directo");
    const deleted = await request("DELETE", "/1?codSucursal=001");
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(await model.findByPk({ id: 1, codSucursal: "001" }), null);
    assert.equal((await model.findByPk({ id: 1, codSucursal: "002" })).get("valor"), "002");
  } finally {
    await api.close();
    await new Promise(resolve => server.close(resolve));
  }
});
