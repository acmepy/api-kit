import { it } from "node:test";
import assert from "node:assert/strict";
import { createApp, effectScope } from "vue";
import { createApi, BaseService, defineResource } from "../src/server/index.js";
import { createApiClient } from "../src/client/index.js";
import { createApiVue, useApiService } from "../src/vue/index.js";
import { createTestSeq } from "./helpers/seq.js";
import { parseCsv } from "../src/server/import/csv.js";
import { JSDOM } from "jsdom";

async function fixture(t, options = {}) {
  const seq = createTestSeq({ logging: false });
  const api = await createApi({ seq, basePath: "/api", audit: true, schema: true, ...options,
    modules: [{ name: "productos", modelName: "ProductoImport", maxSize: 10, attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      codigo: { type: "string", allowNull: false, unique: true, regexp: /^[A-Z][0-9]+$/ },
      descripcion: { type: "string", title: "Descripción", allowNull: false },
      importe: { type: "decimal", precision: 12, scale: 2, min: 0, defaultValue: 0 },
      activo: { type: "boolean", defaultValue: true },
      interno: { type: "string", create: false },
    } }, { name: "claves", modelName: "ClaveImport", timestamps: false, attributes: {
      lista: { type: "string", primaryKey: true }, articulo: { type: "string", primaryKey: true }, descripcion: { type: "string", allowNull: false },
    } }],
  });
  await seq.authenticate(); await seq.init(); await seq.sync({ force: true });
  const server = await new Promise(resolve => { const listener = api.app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(async () => { await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const send = async (body, query = "", resource = "productos") => {
    const response = await fetch(`${url}/${resource}/import${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  return { api, seq, url, send };
}

it("previews typed records and errors without writing records or audit, then validates confirmation again", async t => {
  const { api, send } = await fixture(t);
  const result = await send([{ id: 999, codigo: "A1", descripcion: "Cámara", importe: "12.5", interno: "oculto" }, { codigo: "mal", importe: -1 }], "?preview=true");
  assert.equal(result.status, 200);
  assert.equal(result.ok, false);
  assert.equal(result.data.valid, 1);
  assert.equal(result.data.created, 0);
  assert.equal(result.data.errors[0].row, 2);
  assert.ok(result.data.errors[0].errors.codigo);
  assert.ok(result.data.errors[0].errors.descripcion);
  assert.ok(result.data.errors[0].errors.importe);
  assert.equal(result.data.rows[0].data.importe, 12.5);
  assert.equal(result.data.rows[0].data.id, undefined);
  assert.equal(result.data.rows[0].data.interno, undefined);
  assert.equal(await api.models.get("productos").count(), 0);
  assert.equal(await api.models.get("audit").count(), 0);
  await api.services.get("productos").create({ body: { codigo: "A1", descripcion: "Otro usuario" } });
  const changed = await send([{ codigo: "A1", descripcion: "Cámara" }]);
  assert.equal(changed.data.failed, 1);
  assert.equal(changed.data.created, 0);
  assert.equal(await api.models.get("productos").count(), 1);
});

it("rolls back all valid rows on atomic errors and keeps valid rows in partial mode", async t => {
  const { api, send } = await fixture(t);
  const rows = [{ codigo: "A1", descripcion: "Uno" }, { codigo: "A2" }, { codigo: "A3", descripcion: "Tres" }];
  const atomic = await send(rows);
  assert.equal(atomic.data.rolledBack, true);
  assert.equal(atomic.data.created, 0);
  assert.equal(atomic.data.failed, 1);
  assert.equal(await api.models.get("productos").count(), 0);
  assert.equal(await api.models.get("audit").count(), 0);
  const partial = await send(rows, "?atomic=false");
  assert.equal(partial.ok, false);
  assert.equal(partial.data.created, 2);
  assert.equal(partial.data.failed, 1);
  assert.equal(partial.data.rolledBack, false);
  assert.equal(await api.models.get("productos").count(), 2);
  assert.equal(await api.models.get("audit").count(), 2);
});

it("skips unique and composite PK duplicates without updating existing rows", async t => {
  const { api, send } = await fixture(t);
  const rows = [{ codigo: "A1", descripcion: "Uno" }, { codigo: "A1", descripcion: "Repetido" }, { codigo: "A2", descripcion: "Dos" }];
  const preview = await send(rows, "?preview=true&duplicates=skip");
  assert.equal(preview.data.skipped, 1);
  const result = await send(rows, "?duplicates=skip");
  assert.equal(result.ok, true);
  assert.equal(result.data.created, 2);
  assert.equal(result.data.skipped, 1);
  const retry = await send(rows, "?duplicates=skip");
  assert.equal(retry.data.created, 0);
  assert.equal(retry.data.skipped, 3);
  const saved = await api.models.get("productos").findOne({ where: { codigo: "A1" } });
  assert.equal(saved.get("descripcion"), "Uno");
  const key = { lista: "001", articulo: "A1", descripcion: "Detalle" };
  const manual = await send([key, { ...key, descripcion: "Duplicado" }], "?duplicates=skip", "claves");
  assert.equal(manual.data.created, 1);
  assert.equal(manual.data.skipped, 1);
  assert.equal((await api.models.get("claves").findAll())[0].get("lista"), "001");
  const missing = await send([{ lista: "001", descripcion: "Sin articulo" }], "?preview=true", "claves");
  assert.ok(missing.data.errors[0].errors.articulo);
  const invalid = await send([{ codigo: "mal", descripcion: "Formato incorrecto" }], "?duplicates=skip");
  assert.equal(invalid.data.skipped, 0);
  assert.equal(invalid.data.failed, 1);
});

it("normalizes server defaults and dates before checking unique values", async () => {
  const resource = defineResource({ modelName: "ImportDefaults", timestamps: false, attributes: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    codigo: { type: "string", unique: true, defaultValue: () => "DEFAULT" },
    fecha: { type: "date", unique: true },
    activo: { type: "boolean", defaultValue: true },
  } });
  const seq = createTestSeq({ models: [resource.model], logging: false });
  await seq.authenticate(); await seq.init(); await seq.sync({ force: true });
  const service = new BaseService({ model: resource.model, schemas: resource.schemas, seq, config: { resource } });
  const first = await service.import({ body: [{ fecha: "2026-11-25T14:00:00-03:00", activo: "false" }, {}], query: { duplicates: "skip" } });
  assert.equal(first.data.created, 1);
  assert.equal(first.data.skipped, 1);
  assert.equal((await resource.model.findAll())[0].get("activo"), false);
  const retry = await service.import({ body: [{ codigo: "OTHER", fecha: "2026-11-25T17:00:00Z" }], query: { duplicates: "skip", preview: true } });
  assert.equal(retry.data.skipped, 1);
  assert.equal(retry.data.failed, 0);
});

it("parses quoted CSV records, maps headers and numbers logical records independently of physical lines", async t => {
  const { api, send, url } = await fixture(t);
  const text = '\uFEFFCódigo,Descripción,Precio\r\nA1,"Cámara, ""Norte""\ncon luz",12.5\r\nA2,,-1\r\nA3,Tres,\r\n';
  const body = { data: text, mapping: { Código: "codigo", Descripción: "descripcion", Precio: "importe" } };
  const preview = await send(body, "?type=csv&preview=true");
  assert.equal(preview.data.total, 3);
  assert.equal(preview.data.errors[0].row, 2);
  assert.equal(preview.data.rows[0].data.descripcion, 'Cámara, "Norte"\ncon luz');
  const result = await send(body, "?type=csv&atomic=false");
  assert.equal(result.data.created, 2);
  assert.equal(await api.models.get("productos").count(), 2);
  const raw = await fetch(`${url}/productos/import?type=csv`, { method: "POST", headers: { "Content-Type": "text/csv" }, body: "codigo,descripcion\nA4,Cuatro" });
  assert.equal((await raw.json()).data.created, 1);
  assert.throws(() => parseCsv('a,a\n1,2'), /duplicados/);
  assert.throws(() => parseCsv('a,b\n"sin cerrar'), /sin cerrar/);
  assert.throws(() => parseCsv('a,b\n1,2,3'), /columnas/);
  assert.equal(parseCsv('a,b\n,\n').length, 1, "An explicitly empty record must be validated");
});

it("downloads editable required-field templates and serves a CSP-compatible optional import page", async t => {
  const { api, url, send } = await fixture(t, { helmet: true });
  const template = await fetch(`${url}/productos/import/template`);
  assert.equal(template.status, 200);
  const rows = await template.json();
  assert.ok(rows[0].codigo);
  assert.ok(rows[0].descripcion);
  assert.equal(rows[0].id, undefined);
  assert.equal(rows[0].interno, undefined);
  assert.equal(rows[0].createdAt, undefined);
  const csv = await fetch(`${url}/productos/import/template?type=csv`);
  assert.ok(parseCsv(await csv.text()).length > 0);
  api.services.get("productos").importExamples = () => [{ codigo: "A1", descripcion: "Ejemplo ajustado" }];
  const custom = await (await fetch(`${url}/productos/import/template`)).json();
  assert.equal((await send(custom, "?preview=true")).data.failed, 0);
  const page = await fetch(`${url}/productos/import`);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /Validar y previsualizar/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match((await (await fetch(`${url}/productos/import?asset=script`)).text()), /Confirm|submit/);
  assert.match((await fetch(`${url}/productos/import?asset=style`)).headers.get("content-type"), /text\/css/);
});

it("uses import/template through client and Vue, returning partial summaries instead of throwing", async t => {
  const { url } = await fixture(t);
  const client = createApiClient({ url, changes: false, sse: false, serviceSyncDelay: false, pingInterval: 60_000 });
  t.after(() => client.destroy());
  await new Promise(resolve => client.onChange(event => { if (event.source === "ping") resolve(); }));
  await client.syncServices();
  const service = client.service("productos");
  const file = await service.importTemplate({ type: "csv" });
  assert.equal(file.filename, "productos-import.csv");
  const api = createApiVue(client); t.after(() => api.dispose());
  const app = createApp({ render: () => null }); app.use(api);
  const scope = effectScope(); t.after(() => scope.stop());
  const resource = scope.run(() => app.runWithContext(() => useApiService("productos")));
  const data = [{ id: 900, codigo: "A1", descripcion: "Importado" }, { codigo: "A2" }];
  const preview = await resource.import(data, { preview: true });
  assert.equal(preview.ok, false);
  assert.equal(preview.data.failed, 1);
  assert.equal(preview.data.created, 0);
  const result = await resource.import(data, { atomic: false });
  assert.equal(result.data.created, 1);
  const csv = new Blob(["codigo,descripcion\nA3,Archivo CSV"], { type: "text/csv" });
  assert.equal((await service.import(csv)).data.created, 1);
  const reloaded = await service.pull();
  assert.equal(reloaded.data.length, 2);
  assert.ok(reloaded.data.every(row => row.id !== 900));
});

it("protects preview, confirmation and templates with the resource import permission", async t => {
  const { api, url } = await fixture(t, { auth: { required: true, secret: "import-secret" } });
  const models = api.auth.models;
  await models.users.create({ id: "reader", password: "1234" });
  const role = await models.roles.create({ role: "reader" });
  await models.usersRoles.create({ userId: "reader", roleId: role.get("id") });
  const login = async () => (await (await fetch(`${url}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "reader", password: "1234" }) })).json()).data;
  let session = await login();
  for (const path of ["/productos/import?preview=true", "/productos/import"]) {
    assert.equal((await fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` }, body: "[]" })).status, 403);
  }
  assert.equal((await fetch(`${url}/productos/import/template`, { headers: { Authorization: `Bearer ${session.token}` } })).status, 403);
  assert.equal((await fetch(`${url}/productos/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" })).status, 401);
  const permission = await models.permissions.create({ permission: "productos.import" });
  await models.rolesPermissions.create({ roleId: role.get("id"), permissionId: permission.get("id") });
  session = await login();
  const permitted = await fetch(`${url}/productos/import?preview=true`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` }, body: "[]" });
  assert.equal(permitted.status, 200);
  assert.equal((await permitted.json()).data.created, 0);
});

it("rejects invalid options and oversized requests before processing any row", async t => {
  const { api, send } = await fixture(t);
  for (const query of ["?type=pdf", "?atomic=wrong", "?preview=wrong", "?duplicates=replace"]) {
    assert.equal((await send([], query)).status, 400);
  }
  assert.equal((await send(Array.from({ length: 11 }, () => ({ codigo: "A1", descripcion: "Demasiados" })))).status, 400);
  assert.equal((await send({ data: [{ codigo: "A1" }], mapping: { codigo: "id" } })).status, 400);
  assert.equal(await api.models.get("productos").count(), 0);
});

it("supports mapping, blocks confirmation on errors, and imports only after a fresh preview in the HTML page", async t => {
  const { api, url } = await fixture(t);
  const html = await (await fetch(`${url}/productos/import`)).text();
  const script = await (await fetch(`${url}/productos/import?asset=script`)).text();
  const dom = new JSDOM(html, { url: `${url}/productos/import`, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.fetch = (path, options) => fetch(new URL(path, url), options);
  dom.window.eval(script);
  const { document, Event } = dom.window;
  const $ = id => document.getElementById(id);
  const waitFor = async test => {
    const deadline = Date.now() + 3000;
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`UI did not finish: ${$("message").textContent}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  Object.defineProperty($("file"), "files", { value: [{ name: "test.csv", text: async () => 'Código,Descripción\nA1,"<img src=x onerror=alert(1)>"\nA2,\n' }] });
  $("file").dispatchEvent(new Event("change"));
  $("preview").click();
  await waitFor(() => !$("preview").disabled && $("results").hidden === false);
  assert.equal($("confirm").disabled, true);
  for (const [source, target] of [["Código", "codigo"], ["Descripción", "descripcion"]]) {
    const select = [...$("mapping").querySelectorAll("select")].find(node => node.dataset.source === source);
    select.value = target; select.dispatchEvent(new Event("change"));
  }
  $("preview").click();
  await waitFor(() => !$("preview").disabled);
  assert.match($("summary").textContent, /Válidos: 1/);
  assert.equal($("confirm").disabled, true, "Atomic mode blocks a preview with errors");
  assert.equal(document.querySelector("img"), null, "File contents are shown as text");
  $("atomic").checked = false; $("atomic").dispatchEvent(new Event("change"));
  assert.equal($("confirm").disabled, true);
  $("preview").click();
  await waitFor(() => !$("preview").disabled);
  assert.equal($("confirm").disabled, false);
  assert.equal(await api.models.get("productos").count(), 0);
  $("confirm").click();
  await waitFor(() => $("message").textContent === "Importación finalizada.");
  assert.equal(await api.models.get("productos").count(), 1);
  assert.equal($("confirm").disabled, true);
});
