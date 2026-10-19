import { it } from "node:test";
import assert from "node:assert/strict";
import { BaseService, PendingService, createAdapter } from "../src/client/index.js";

function fixture(request = async (_path, { body }) => ({ ok: true, data: body })) {
  const services = new Map();
  const client = { services: () => services, connected: () => false, request };
  const pending = new PendingService({ client });
  services.set("pending", pending);
  for (const name of ["schema", "session"]) services.set(name, { name, push() { throw new Error("Internal service must not be pushed"); } });
  function resource(name, primaryKeyAttributes = ["id"]) {
    const service = new BaseService({ client, name, primaryKeyAttributes, createAdapter,
      operations: {
        create: { path: `/${name}`, method: "POST" },
        update: { path: `/${name}/{id}`, method: "PUT" },
        remove: { path: `/${name}/{id}`, method: "DELETE" },
      },
    });
    services.set(name, service);
    return service;
  }
  return { services, pending, resource };
}

it("pending.push sends every resource and does not resend successful creates, updates or deletes", async () => {
  const calls = [];
  const { pending, resource } = fixture(async (path, options) => {
    calls.push({ path, ...options });
    return { ok: true, data: options.body };
  });
  const facturas = resource("facturas");
  const recibos = resource("recibos", ["numero", "sucursal"]);
  await facturas.create({ id: 1, importe: 100 });
  await recibos.adapter.add([{ numero: 1, sucursal: "001", importe: 100 }, { numero: 1, sucursal: "002", importe: 200 }]);
  await recibos.update({ numero: 1, sucursal: "001" }, { importe: 150 });
  await recibos.remove({ numero: 1, sucursal: "002" });
  assert.equal((await pending.list()).data.length, 3);
  const result = await pending.push();
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.results.map(({ service, operation }) => [service, operation]), [
    ["facturas", "create"], ["recibos", "update"], ["recibos", "remove"],
  ]);
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "PUT", "DELETE"]);
  assert.deepEqual(calls[1].query, { numero: 1, sucursal: "001" });
  assert.deepEqual((await recibos.list()).data, [{ numero: 1, sucursal: "001", importe: 150 }]);
  assert.deepEqual((await pending.list()).data, []);
  assert.deepEqual(await pending.push(), { ok: true, results: [], errors: [] });
  assert.equal(calls.length, 3);
});

it("pending.push identifies failures by resource, preserves rejected records and retries only failures", async () => {
  let reject = true;
  const calls = [];
  const { pending, resource } = fixture(async (path, { body }) => {
    calls.push(path);
    if (path === "/facturas" && reject) {
      const error = new Error("Importe invalido");
      error.errors = { importe: "Debe ser positivo" };
      throw error;
    }
    return { ok: true, data: body };
  });
  const facturas = resource("facturas");
  const recibos = resource("recibos");
  await facturas.create({ id: 1, importe: 100 });
  await recibos.create({ id: 1, importe: 100 });
  const result = await pending.push();
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].service, "facturas");
  assert.equal(result.errors[0].id, 1);
  assert.deepEqual(result.errors[0].errors, { importe: "Debe ser positivo" });
  assert.equal((await facturas.get(1)).data.pending, true);
  reject = false;
  assert.equal((await pending.push()).ok, true);
  assert.deepEqual(calls, ["/facturas", "/recibos", "/facturas"]);
  assert.deepEqual((await pending.list()).data, []);
});

it("pending.push shares concurrent sends and continues after a service throws", async () => {
  const { pending, services, resource } = fixture();
  services.set("broken", { name: "broken", push: async () => { throw new Error("Storage unavailable"); } });
  const service = resource("facturas");
  await service.create({ id: 1 });
  const first = pending.push();
  const second = pending.push();
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].service, "broken");
  assert.equal(result.errors[0].error, "Storage unavailable");
  assert.equal(result.results[1].ok, true);
  services.delete("broken");
  assert.deepEqual(await pending.push(), { ok: true, results: [], errors: [] });
});
