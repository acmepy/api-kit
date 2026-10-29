// Runs the actual example against a temporary in-memory database.
import assert from "node:assert/strict";
import { createApiClient } from "api/client";
import { start } from "./app.js";

const example = await start({ port: 0, database: ":memory:" });
const client = createApiClient({ url: `${example.url}/api`, sse: false, changes: false, serviceSyncDelay: false });
const admin = createApiClient({ url: `${example.url}/api`, sse: false, changes: false, serviceSyncDelay: false });
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
  await assert.rejects(() => client.request("/admin/tenants"), error => error.status === 403);
  assert.equal((await fetch(`${example.url}/api/admin/tenants`)).status, 401);
  await admin.login({ username: "admin", password: "1234" });
  const tenantsBefore = (await admin.request("/admin/tenants")).data.length;
  for (const maxFacturas of [-1, 1.5, null, "2"]) {
    await assert.rejects(() => admin.request("/admin/tenants", { method: "POST", body: { name: "Inválido", maxFacturas } }), error => error.status === 400);
  }
  assert.equal((await admin.request("/admin/tenants")).data.length, tenantsBefore);
  const { data: createdTenant } = await admin.request("/admin/tenants", { method: "POST", body: { name: "Empresa nueva", maxFacturas: 2 } });
  assert.ok((await client.getTenants()).data.some(tenant => tenant.id === createdTenant.id));
  await client.setSessionTenant(createdTenant.id);
  await assert.rejects(() => client.service("facturas").create({ cliente: "Inválido", items: [{ articulo: "Error", cantidad: 0 }] }), error => error.status === 400);
  assert.equal((await client.request("/tenant-plan")).data.facturas, 0, "Failed nested creation consumes no capacity");
  const attempts = await Promise.allSettled([1, 2, 3].map(n => client.request("/facturas", {
    method: "POST", body: { cliente: `Concurrente ${n}` },
  })));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 2);
  const failures = attempts.filter(result => result.status === "rejected");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason.code, "TENANT_INVOICE_LIMIT");
  assert.equal(failures[0].reason.status, 409);
  const row = (await admin.request("/admin/tenants")).data.find(tenant => tenant.id === createdTenant.id);
  assert.equal(row.facturas, 2); assert.equal(row.maxFacturas, 2);
  await assert.rejects(() => client.request(`/admin/tenants/${createdTenant.id}/limit`, { method: "PATCH", body: { maxFacturas: 100 } }), error => error.status === 403);
  await admin.request(`/admin/tenants/${createdTenant.id}/limit`, { method: "PATCH", body: { maxFacturas: 1 } });
  assert.equal((await client.service("facturas").pull()).data.length, 2, "Lowering the limit preserves invoices");
  await assert.rejects(() => client.service("facturas").create({ cliente: "Sobre el límite" }), error => error.code === "TENANT_INVOICE_LIMIT");
  const invoices = (await client.service("facturas").list()).data;
  await client.service("facturas").update(invoices[0].id, { cliente: "Edición permitida" });
  await admin.request(`/admin/tenants/${createdTenant.id}/limit`, { method: "PATCH", body: { maxFacturas: 2 } });
  await client.service("facturas").remove(invoices[0].id);
  await client.service("facturas").create({ cliente: "Espacio liberado" });
  assert.equal((await client.request("/tenant-plan")).data.facturas, 2);
  await admin.request(`/admin/tenants/${createdTenant.id}/limit`, { method: "PATCH", body: { maxFacturas: 0 } });
  await assert.rejects(() => client.service("facturas").create({ cliente: "Bloqueado" }), error => error.code === "TENANT_INVOICE_LIMIT");
  await client.setSessionTenant(2);
  assert.equal((await client.request("/tenant-plan")).data.maxFacturas, 10, "Limits are independent across tenants");
  console.log("OK: login, master/detail, isolation, administration, permissions, quotas, concurrent creates and rollback.");
} finally {
  client.destroy();
  admin.destroy();
  await example.close();
}
