import { it } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../src/server/index.js";
import { createTestSeq } from "./helpers/seq.js";

it("keeps master errors flat and groups nested detail errors by model", async t => {
  const messages = [];
  const seq = createTestSeq({ logging: false });
  const api = await createApi({ seq, basePath: "/api", logging: { warn: (...args) => messages.push(args) },
    modules: [{ name: "recibos", modelName: "RecibosCab", timestamps: false,
      attributes: { id: { type: "integer", primaryKey: true, autoIncrement: true }, codMoneda: { type: "integer", allowNull: false } },
      details: [{ name: "detalles", modelName: "RecibosDet", timestamps: false,
        attributes: { id: { type: "integer", primaryKey: true, autoIncrement: true }, reciboId: { type: "integer", create: false, update: false, allowNull: false },
          codMoneda: { type: "integer", allowNull: false } } }],
    }],
  });
  await seq.authenticate(); await seq.init(); await seq.sync({ force: true });
  const server = await new Promise(resolve => { const listener = api.app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(async () => { await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const check = (result, model, nested = false) => {
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.code, "VALIDATION_ERROR");
    const fields = nested ? result.body.errors[model] : result.body.errors;
    assert.equal(typeof fields.codMoneda, "string");
    if (nested) assert.equal(result.body.errors.codMoneda, undefined);
    assert.deepEqual(result.body.details, { model });
    assert.equal(JSON.parse(messages.at(-1)[2]).error.details.model, model, "HTTP log includes the failing model");
  };
  check(await request("POST", "/recibos", { detalles: [{ codMoneda: 1 }] }), "RecibosCab");
  check(await request("POST", "/recibos", { codMoneda: 1, detalles: [{}] }), "RecibosDet", true);
  assert.equal(await api.models.get("recibos").count(), 0, "Invalid nested create rolls back the master");
  const created = await request("POST", "/recibos", { codMoneda: 1, detalles: [{ codMoneda: 1 }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.data.id;
  check(await request("PUT", `/recibos/${id}`, { codMoneda: "invalid" }), "RecibosCab");
  check(await request("PUT", `/recibos/${id}`, { codMoneda: 1, detalles: [{}] }), "RecibosDet", true);
  check(await request("POST", `/recibos/${id}/detalles`, {}), "RecibosDet");
  const detailId = created.body.data.detalles[0].id;
  check(await request("PUT", `/recibos/${id}/detalles/${detailId}`, { codMoneda: "invalid" }), "RecibosDet");
});
