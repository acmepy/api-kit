// Runs the actual example against a temporary in-memory database.
import assert from "node:assert/strict";
import { createApiClient } from "api/client";
import { start } from "./app.js";

const example = await start({ port: 0, database: ":memory:" });
const client = createApiClient({ url: `${example.url}/api`, sse: false, changes: false, serviceSyncDelay: false });
try {
  for (const asset of ["/", "/browser.js", "/assets/api/api-client.js", "/assets/yep/yep.js", "/assets/idb-keyval/index.js", "/assets/bootstrap/css/bootstrap.min.css"]) {
    assert.equal((await fetch(example.url + asset)).status, 200, asset);
  }
  await client.login({ username: "demo", password: "1234" });
  assert.equal((await client.session()).tenantId, 1);
  assert.deepEqual((await client.getTenants()).data.map(row => row.id).sort(), [1, 2]);
  const first = await client.service("facturas").create({ cliente: "Cliente Norte",
    items: [{ articulo: "Artículo A", cantidad: 2 }, { articulo: "Artículo B", cantidad: 1 }] });
  assert.equal(first.data.codEmpresa, 1);
  assert.equal(first.data.items.length, 2);
  assert.ok(first.data.items.every(item => item.codEmpresa === 1));
  const id = first.data.id;
  await client.service("facturas").update(id, { cliente: "Cliente editado" });
  const item = await client.service("facturas").createDetail(id, "items", { articulo: "Artículo C", cantidad: 3 });
  await client.service("facturas").updateDetail(id, "items", item.data.id, { cantidad: 4 });
  let current = (await client.service("facturas").pull()).data.find(row => row.id === id);
  assert.equal(current.items.find(row => row.id === item.data.id).cantidad, 4);
  await client.service("facturas").removeDetail(id, "items", item.data.id);
  await client.setSessionTenant(2);
  assert.equal((await client.service("facturas").list()).data.length, 0);
  await assert.rejects(() => client.service("facturas").pullOne(id), error => error.status === 404);
  const second = await client.service("facturas").create({ cliente: "Cliente Sur", items: [{ articulo: "Otro", cantidad: 1 }] });
  assert.equal(second.data.codEmpresa, 2);
  await assert.rejects(() => client.setSessionTenant(999), error => error.status === 403);
  await client.setUserTenant(2);
  await client.setSessionTenant(1);
  current = (await client.service("facturas").pull()).data.find(row => row.id === id);
  assert.equal(current.cliente, "Cliente editado");
  assert.equal(current.items.length, 2);
  assert.deepEqual((await client.service("facturas").list()).data.map(row => row.id), [id]);
  for (const detail of current.items) await client.service("facturas").removeDetail(id, "items", detail.id);
  await client.service("facturas").remove(id);
  await client.logout();
  await client.login({ username: "demo", password: "1234" });
  assert.equal((await client.session()).tenantId, 2, "New login uses the user's default tenant");
  console.log("OK: login, tenants, isolation, nested create, master/detail CRUD, default tenant and assets.");
} finally {
  client.destroy();
  await example.close();
}
