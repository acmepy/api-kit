import { it } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../src/server/index.js";
import { BaseService } from "../src/client/services/base-service.js";
import { MapAdapter } from "../src/client/adapters/map-adapter.js";
import { discoverServiceDescriptors } from "../src/client/schema-descriptors.js";
import { createTestSeq } from "./helpers/seq.js";

it("schema.json preserves requiredOneOf and the client rejects missing documents before sending", async () => {
  const seq = createTestSeq({ logging: false });
  const api = await createApi({ seq, basePath: "/api", schema: true, modules: [{
    name: "registro-cliente", modelName: "RegistroCliente", timestamps: false,
    requiredOneOfCreate: ["ruc", "cedula"],
    attributes: {
      id: { type: "string", primaryKey: true },
      ruc: { type: "string", allowNull: true },
      cedula: { type: "string", allowNull: true },
      nombre: { type: "string" },
    },
  }] });
  const server = await new Promise(resolve => {
    const listener = api.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/schema.json`);
    assert.equal(response.status, 200);
    const [descriptor] = discoverServiceDescriptors(await response.json(), "/api");
    assert.deepEqual(descriptor.schemas.create.requiredOneOf, ["ruc", "cedula"]);
    assert.equal(descriptor.schemas.update.requiredOneOf, undefined);
    let sent = 0;
    const service = new BaseService({ ...descriptor, createAdapter: () => new MapAdapter(),
      client: { connected: () => true, request: async () => { sent++; throw new Error("No debe enviar datos inválidos"); } } });
    for (const value of [{}, { ruc: null, cedula: null }, { ruc: "", cedula: "" }]) {
      await assert.rejects(() => service.create(value), error =>
        /Debe completar al menos uno/.test(error.errors?.ruc) && /Debe completar al menos uno/.test(error.errors?.cedula));
    }
    assert.equal(sent, 0);
    for (const value of [{ ruc: "1234567-8" }, { cedula: "1234567" }, { ruc: "1234567-8", cedula: "1234567" }]) {
      assert.deepEqual(await service.validate(value), value);
    }
    assert.deepEqual(await service.validate({ nombre: "Cambio parcial" }, "update"), { nombre: "Cambio parcial" });
  } finally {
    await api.close();
    await new Promise(resolve => server.close(resolve));
  }
});
