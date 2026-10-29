import { it } from "node:test";
import assert from "node:assert/strict";
import { createApi, getContext } from "../src/server/index.js";
import { createTestSeq } from "./helpers/seq.js";
import { createApiClient } from "../src/client/index.js";
import { createApiVue, useApiService } from "../src/vue/index.js";
import { createApp, effectScope, nextTick } from "vue";

async function fixture(t) {
  const seq = createTestSeq({ getContext, logging: false, tenant: { attribute: "codEmpresa" } });
  const api = await createApi({ seq, basePath: "/api", tenant: { attribute: "codEmpresa" },
    auth: { secret: "tenant-secret" }, audit: { heartbeatTimeout: 20 }, schema: true,
    modules: [{ name: "facturas", modelName: "Factura", tableName: "facturas", tenant: true, timestamps: false,
      attributes: { id: { type: "integer", primaryKey: true, autoIncrement: true },
        codEmpresa: { type: "integer", allowNull: false }, nombre: { type: "string", allowNull: false } },
      details: [{ name: "items", modelName: "Item", tableName: "items", tenant: { attribute: "empresaDetalle" }, timestamps: false,
        attributes: { id: { type: "integer", primaryKey: true, autoIncrement: true }, facturaId: { type: "integer", allowNull: false, create: false, update: false },
          empresaDetalle: { type: "integer", allowNull: false }, cantidad: { type: "integer", min: 1, allowNull: false } } }],
    }, { name: "claves", modelName: "Clave", tenant: true, timestamps: false,
      attributes: { codEmpresa: { type: "integer", primaryKey: true, allowNull: false }, codigo: { type: "string", primaryKey: true, allowNull: false }, nombre: { type: "string" } },
    }],
  });
  await seq.authenticate(); await seq.init(); await seq.sync({ force: true });
  const m = api.auth.models;
  for (const id of [1, 2, 3]) await m.tenants.create({ id, name: `Empresa ${id}` });
  await m.roles.create({ id: 1, role: "admin" });
  for (const id of ["one", "two"]) {
    await m.users.create({ id, password: "old", tenantId: id === "one" ? 1 : 2 });
    await m.usersRoles.create({ userId: id, roleId: 1 });
    for (const tenantId of id === "one" ? [1, 2] : [2]) await m.usersTenants.create({ userId: id, tenantId });
  }
  const permissions = ["claves.list", "claves.create", "claves.update", "schema.list", "facturas.list", "facturas.get", "facturas.create", "facturas.update", "facturas.remove", "facturas.createDetail", "facturas.updateDetail", "facturas.removeDetail", "audit.changes", "audit.sse"];
  for (const permission of permissions) {
    const p = await m.permissions.create({ permission });
    await m.rolesPermissions.create({ roleId: 1, permissionId: p.get("id") });
  }
  const server = await new Promise(resolve => { const listener = api.app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => { await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = async (method, path, body, token) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "x-tenant-id": "999", ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body !== undefined && { body: JSON.stringify(body) }) });
    return { status: res.status, ...(await res.json()) };
  };
  const login = async user => {
    const res = await request("POST", "/login", { username: user, password: "old", tenantId: 3 });
    assert.equal(res.status, 200, JSON.stringify(res)); return res.data;
  };
  return { api, seq, base, request, login, models: m };
}

it("tenant CRUD and nested details isolate data, reject forged tenant fields and preserve validation", async t => {
  const { api, request, login } = await fixture(t);
  const one = await login("one"), two = await login("two");
  const a = await request("POST", "/facturas", { nombre: "Uno", items: [{ cantidad: "2" }] }, one.token);
  const b = await request("POST", "/facturas", { nombre: "Dos", items: [{ cantidad: 3 }] }, two.token);
  assert.equal(a.status, 200, JSON.stringify(a)); assert.equal(b.status, 200, JSON.stringify(b));
  assert.equal(a.data.codEmpresa, 1); assert.equal(a.data.items[0].empresaDetalle, 1);
  assert.equal(a.data.items[0].cantidad, 2);
  const lists = await Promise.all([one, two].map(session => request("GET", "/facturas", undefined, session.token)));
  assert.deepEqual(lists.map(res => res.data.map(row => row.nombre)), [["Uno"], ["Dos"]]);
  for (const [method, path, body] of [["GET", `/facturas/${b.data.id}`], ["PUT", `/facturas/${b.data.id}`, { nombre: "Ajeno" }], ["DELETE", `/facturas/${b.data.id}`]]) {
    assert.equal((await request(method, path, body, one.token)).status, 404);
  }
  assert.equal((await request("POST", "/facturas", { nombre: "Forjado", codEmpresa: 2 }, one.token)).status, 403);
  assert.equal((await request("DELETE", `/facturas/${a.data.id}?codEmpresa=2`, undefined, one.token)).status, 403);
  assert.equal((await request("POST", `/facturas/${b.data.id}/items`, { cantidad: 1 }, one.token)).status, 404);
  const forged = await request("POST", "/facturas", { nombre: "Forjado", items: [{ cantidad: 1, empresaDetalle: 2 }] }, one.token);
  assert.equal(forged.status, 403, JSON.stringify(forged));
  const invalid = await request("PUT", `/facturas/${a.data.id}`, { nombre: "Cambio", items: [{ cantidad: 0 }] }, one.token);
  assert.equal(invalid.status, 400, JSON.stringify(invalid));
  assert.equal((await request("GET", `/facturas/${a.data.id}`, undefined, one.token)).data.nombre, "Uno");
  const detail = await request("POST", `/facturas/${a.data.id}/items`, { cantidad: 4 }, one.token);
  assert.equal(detail.status, 200, JSON.stringify(detail)); assert.equal(detail.data.empresaDetalle, 1);
  assert.equal((await request("PUT", `/facturas/${a.data.id}/items/${detail.data.id}`, { cantidad: 5, empresaDetalle: 2 }, one.token)).status, 403);
  const document = await request("GET", "/schema.json", undefined, one.token);
  const descriptor = document.services?.find(item => item.name === "facturas");
  assert.ok(descriptor, JSON.stringify(document));
  assert.equal(descriptor.schemas.create.properties.codEmpresa, undefined);
  assert.deepEqual(api.models.get("facturas").options.tenant, { attribute: "codEmpresa" });
});

it("tenant endpoints update user and session independently and changes are filtered by Seq", async t => {
  const { api, request, login, models } = await fixture(t);
  const first = await login("one"), other = await login("one"), two = await login("two");
  await request("POST", "/facturas", { nombre: "Uno" }, first.token);
  await request("POST", "/facturas", { nombre: "Dos" }, two.token);
  const changes = await Promise.all([first, two].map(session => request("GET", "/changes?since=2000-01-01", undefined, session.token)));
  assert.ok(changes.every(res => res.status === 200));
  assert.deepEqual(changes.map(res => res.data.map(row => row.codEmpresa)), [[1], [2]]);
  assert.deepEqual(api.models.get("audit").options.tenant, { attribute: "codEmpresa" });
  assert.equal((await request("PATCH", "/session/tenant", { tenantId: 3 }, first.token)).code, "TENANT_FORBIDDEN");
  assert.equal((await request("PATCH", "/session/tenant", { tenantId: 2 }, first.token)).data.tenantId, 2);
  assert.equal((await request("GET", "/facturas", undefined, first.token)).data[0].nombre, "Dos");
  assert.equal((await request("GET", "/session", undefined, other.token)).data.tenantId, 1);
  assert.equal((await models.users.findByPk("one")).get("tenantId"), 1);
  assert.equal((await request("PATCH", "/me/tenant", { tenantId: 2 }, first.token)).data.tenantId, 2);
  assert.equal((await request("GET", "/session", undefined, other.token)).data.tenantId, 1);
  assert.equal((await request("PATCH", "/session/options", { options: { theme: "dark" } }, first.token)).data.options.theme, "dark");
  assert.equal((await request("PATCH", "/me/options", { options: { language: "es" } }, first.token)).data.options.language, "es");
  assert.equal((await request("GET", "/me/tenants", undefined, first.token)).data.length, 2);
  await models.usersTenants.update({ active: false }, { where: { userId: "one", tenantId: 2 } });
  assert.equal((await request("GET", "/facturas", undefined, first.token)).code, "TENANT_FORBIDDEN");
});

const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("Timed out waiting for SSE");
};

async function stream(t, base, token) {
  const abort = new AbortController();
  const response = await fetch(base + "/sse", { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
  assert.equal(response.status, 200);
  const result = { events: [], closed: false };
  const task = (async () => {
    let buffer = "";
    try {
      for await (const part of response.body) {
        buffer += new TextDecoder().decode(part);
        const messages = buffer.split("\n\n"); buffer = messages.pop();
        for (const raw of messages) {
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          if (event) result.events.push({ event, data: JSON.parse(/^data: (.+)$/m.exec(raw)[1]) });
        }
      }
    } catch (error) { if (!abort.signal.aborted) throw error; }
    finally { result.closed = true; }
  })();
  t.after(async () => { abort.abort(); await task; });
  return result;
}

it("SSE filters every event by its connection tenant and closes on selection change or revoked membership", async t => {
  const { request, login, base, models } = await fixture(t);
  const one = await login("one"), two = await login("two");
  const a = await stream(t, base, one.token), b = await stream(t, base, two.token);
  await request("POST", "/facturas", { nombre: "Uno" }, one.token);
  await request("POST", "/facturas", { nombre: "Dos" }, two.token);
  await waitFor(() => a.events.length && b.events.length);
  assert.ok(a.events.every(event => event.data.codEmpresa === 1));
  assert.ok(b.events.every(event => event.data.codEmpresa === 2));
  await request("PATCH", "/session/tenant", { tenantId: 2 }, one.token);
  await waitFor(() => a.closed);
  assert.equal(a.events.at(-1).event, "tenant-changed");
  await models.usersTenants.update({ active: false }, { where: { userId: "two", tenantId: 2 } });
  await waitFor(() => b.closed);
  assert.equal(b.events.at(-1).event, "session-closed");
});

it("client and Vue block tenant changes with pending work, then clear and reload the new tenant", async t => {
  const { request, login, base } = await fixture(t);
  const one = await login("one"), two = await login("two");
  await request("POST", "/facturas", { nombre: "Uno" }, one.token);
  await request("POST", "/facturas", { nombre: "Dos" }, two.token);
  let offline = false;
  const client = createApiClient({ url: base, changes: false, sse: false, serviceSyncDelay: false,
    fetch: (url, options) => { if (offline) throw new TypeError("Network unavailable"); return fetch(url, options); } });
  t.after(() => client.destroy());
  const vue = createApiVue(client); t.after(() => vue.dispose());
  const app = createApp({ render: () => null }); app.use(vue);
  const scope = effectScope(); t.after(() => scope.stop());
  const invoices = scope.run(() => app.runWithContext(() => useApiService("facturas")));
  await vue.login({ username: "one", password: "old" });
  await invoices.refresh();
  assert.deepEqual(invoices.records.value.map(row => row.nombre), ["Uno"]);
  const previousService = client.service("facturas");
  const originalToken = (await client.session()).token;
  await vue.setUserTenant(2);
  assert.equal((await client.session()).tenantId, 1);
  await vue.updateUserOptions({ language: "es" });
  await vue.updateSessionOptions({ theme: "dark" });
  assert.equal((await client.session()).options.theme, "dark");
  assert.equal((await vue.getTenants()).data.length, 2);
  offline = true;
  await assert.rejects(() => client.request("/facturas"));
  const pending = await invoices.save({ nombre: "Pendiente" });
  offline = false;
  await assert.rejects(() => vue.setSessionTenant(2), { code: "TENANT_PENDING_OPERATIONS" });
  assert.equal((await client.session()).tenantId, 1);
  assert.equal((await previousService.pending()).data.length, 1);
  await invoices.remove(pending.data.id);
  const transition = vue.setSessionTenant(2);
  assert.equal(client.tenantChanging(), true);
  await transition; await nextTick(); await invoices.refresh();
  assert.equal(vue.tenantChanging.value, false);
  assert.equal(vue.session.value.tenantId, 2);
  assert.equal((await client.session()).token, originalToken);
  assert.deepEqual(invoices.records.value.map(row => row.nombre), ["Dos"]);
  assert.deepEqual((await client.service("pending").list()).data, []);
  await assert.rejects(() => previousService.create({ nombre: "Stale" }), { code: "SERVICE_REPLACED" });
});

it("offline creates and saves support tenant as part of the composite primary key", async t => {
  const { base } = await fixture(t);
  let offline = false;
  const client = createApiClient({ url: base, sse: false, changes: false, serviceSyncDelay: false,
    fetch: (url, options) => { if (offline) throw new TypeError("Offline"); return fetch(url, options); } });
  t.after(() => client.destroy());
  await client.login({ username: "one", password: "old" });
  const service = client.service("claves");
  offline = true;
  await assert.rejects(() => client.request("/claves"));
  const created = await service.save({ codigo: "001", nombre: "Local" });
  assert.equal(created.data.codEmpresa, 1);
  assert.equal(created.data.pendingTenantId, 1);
  assert.equal(service.keyOf(created.data), '[1,"001"]');
  await service.save({ codEmpresa: 1, codigo: "001", nombre: "Editado" });
  assert.equal((await service.pending()).data[0].operation, "create");
  offline = false;
  assert.equal((await service.push()).ok, true);
  assert.deepEqual((await service.get({ codEmpresa: 1, codigo: "001" })).data, { codEmpresa: 1, codigo: "001", nombre: "Editado" });
  await service.save({ codEmpresa: 1, codigo: "001", nombre: "Confirmado" });
  assert.equal((await service.get({ codEmpresa: 1, codigo: "001" })).data.nombre, "Confirmado");
});
