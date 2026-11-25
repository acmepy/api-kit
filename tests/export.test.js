import { it } from "node:test";
import assert from "node:assert/strict";
import { createApp, effectScope } from "vue";
import { createApi, BaseService, ValidationError, createExportPdfTemplate, defineResource } from "../src/server/index.js";
import { createApiClient } from "../src/client/index.js";
import { createApiVue, useApiService } from "../src/vue/index.js";
import { createTestSeq } from "./helpers/seq.js";

async function fixture(t, options = {}) {
  const seq = createTestSeq({ logging: false });
  const api = await createApi({ seq, basePath: "/api", schema: true, openapi: true, ...options,
    modules: [{ name: "productos", modelName: "Producto", timestamps: false, maxSize: 2, defaultOrder: [["id", "ASC"]],
      attributes: { id: { type: "integer", primaryKey: true }, nombre: { type: "string", title: "Descripción" }, nota: { type: "string" } },
    }],
  });
  await seq.authenticate(); await seq.init(); await seq.sync({ force: true });
  await api.models.get("productos").bulkCreate([
    { id: 1, nombre: 'Cámara, "Norte"', nota: "Una\nlínea" },
    { id: 2, nombre: "Árbol", nota: "=1+1" },
    { id: 3, nombre: "Otro", nota: null },
  ]);
  const server = await new Promise(resolve => { const s = api.app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(async () => { await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { api, url: `http://127.0.0.1:${server.address().port}/api` };
}

it("exports one limited page, filters JSON and quotes CSV with title headers", async t => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/productos/export?limit=999`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /attachment; filename="?productos\.json"?/);
  assert.deepEqual((await response.json()).map(row => row.id), [1, 2]);
  const page = await fetch(`${url}/productos/export?page=2`);
  assert.deepEqual((await page.json()).map(row => row.id), [3]);
  const filtered = await fetch(`${url}/productos/export?type=json&id=2`);
  assert.deepEqual((await filtered.json()).map(row => row.id), [2]);
  const csv = await fetch(`${url}/productos/export?type=csv`);
  assert.match(csv.headers.get("content-type"), /^text\/csv/);
  assert.equal(await csv.text(), '"id","Descripción","nota"\r\n"1","Cámara, ""Norte""","Una\nlínea"\r\n"2","Árbol","\'=1+1"\r\n');
  assert.equal((await fetch(`${url}/productos/export?type=other`)).status, 400);
  assert.equal((await fetch(`${url}/productos/export?type=constructor`)).status, 400);
  assert.equal((await fetch(`${url}/productos/export?type=__proto__`)).status, 400);
  const schema = await (await fetch(`${url}/schema.json`)).json();
  assert.equal(schema.services.find(s => s.name === "productos").operations.export.path, "/api/productos/export");
  const openapi = await (await fetch(`${url}/openapi.json`)).json();
  assert.ok(openapi.paths["/api/productos/export"].get.responses[200].content["application/pdf"]);
});

it("provides an editable dynamic PDF template and generates a PDF from the default service", async t => {
  const { api, url } = await fixture(t);
  const template = createExportPdfTemplate({ title: "Productos", columns: [{ name: "nombre", title: "Descripción" }, { name: "nota" }], data: [{ nombre: "Cámara", nota: null }] });
  assert.equal(template.header().text, "Productos");
  assert.equal(template.footer(1, 2).text, "1 / 2");
  assert.deepEqual(template.content[0].table.body[1], ["Cámara", ""]);
  assert.equal(template.content[0].table.body[0][1].text, "nota");
  const service = api.services.get("productos");
  const original = service.exportPdfTemplate.bind(service);
  service.exportPdfTemplate = data => {
    const doc = original(data);
    doc.header = () => ({ text: "Catálogo de productos" });
    doc.footer = () => ({ text: "Pie personalizado" });
    return doc;
  };
  const pdf = await fetch(`${url}/productos/export?type=pdf`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get("content-type"), /^application\/pdf/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  assert.equal((await fetch(`${url}/productos/export?type=pdf&id=99`)).status, 200, "An empty table is valid");
});

it("formats declared PDF numbers, proportions maxLength widths and draws boolean symbols", () => {
  const resource = defineResource({ modelName: "Reporte", timestamps: false, attributes: {
    descripcion: { type: "string", title: "Descripción", maxLength: 80 },
    referencia: { type: "string", maxLength: 40 },
    cantidad: { type: "integer" },
    importe: { type: "decimal", precision: 12, scale: 2 },
    medida: { type: "number", precision: 10, scale: 3 },
    activo: { type: "boolean" },
  } });
  const service = new BaseService({ model: resource.model, config: { name: "reporte", resource } });
  const columns = service.exportColumns();
  assert.equal(columns[0].maxLength, 80);
  assert.equal(columns[3].type, "DECIMAL");
  assert.equal(columns[3].scale, 2);
  const template = service.exportPdfTemplate([
    { descripcion: "Cámara", referencia: "ABC", cantidad: 12345, importe: "12345.6", medida: 1234.5, activo: true },
    { cantidad: 0, importe: -1500, medida: null, activo: false },
    { cantidad: null, importe: null, activo: null },
  ]);
  const { widths, body } = template.content[0].table;
  assert.ok(Math.abs(parseFloat(widths[0]) / parseFloat(widths[1]) - 2) < 1e-10);
  assert.ok(Math.abs(widths.reduce((sum, width) => sum + parseFloat(width), 0) - 100) < 1e-10);
  assert.deepEqual(body[1][2], { text: "12.345", alignment: "right" });
  assert.deepEqual(body[1][3], { text: "12.345,60", alignment: "right" });
  assert.deepEqual(body[1][4], { text: "1.234,500", alignment: "right" });
  assert.deepEqual(body[2][3], { text: "-1.500,00", alignment: "right" });
  assert.deepEqual(body[2][2], { text: "0", alignment: "right" });
  assert.equal(body[0][3].alignment, "right");
  assert.equal(body[1][5].canvas[0].type, "polyline");
  assert.equal(body[2][5].canvas.length, 2);
  assert.equal(body[3][5], "");
  assert.equal(body[3][2].text, "");
  assert.equal(body[1][5].canvas[0].lineColor, undefined);
});

it("allows overriding only CSV or the export dispatcher to restrict and add formats", async t => {
  const { api } = await fixture(t);
  class Custom extends BaseService {
    async exportCsv() { return { body: "CSV propio", filename: "propio.csv", contentType: "text/csv" }; }
    async export(args = {}) {
      if (args.query?.type === "pdf") throw new ValidationError("PDF deshabilitado");
      if (args.query?.type === "txt") return { body: "Texto", filename: "productos.txt", contentType: "text/plain" };
      return super.export(args);
    }
  }
  const current = api.services.get("productos");
  const service = new Custom({ model: current.model, config: current.config });
  assert.equal((await service.export({ query: { type: "csv" } })).body, "CSV propio");
  assert.equal(JSON.parse((await service.export()).body).length, 2);
  assert.equal((await service.export({ query: { type: "txt" } })).body, "Texto");
  await assert.rejects(service.export({ query: { type: "pdf" } }), /PDF deshabilitado/);
});

it("downloads JSON, CSV and PDF as files through client and Vue without modifying the cache", async t => {
  const { url } = await fixture(t);
  const client = createApiClient({ url, changes: false, sse: false, serviceSyncDelay: false, pingInterval: 60_000 });
  t.after(() => client.destroy());
  await new Promise(resolve => client.onChange(event => { if (event.source === "ping") resolve(); }));
  await client.syncServices();
  const service = client.service("productos");
  for (const type of ["json", "csv", "pdf"]) {
    const file = await service.export({ type, id: 2 });
    assert.ok(file.blob instanceof Blob);
    assert.equal(file.filename, `productos.${type}`);
    assert.ok(file.blob.size > 0);
    if (type === "json") assert.deepEqual(JSON.parse(await file.blob.text()).map(row => row.id), [2]);
  }
  assert.equal((await service.list()).data.length, 0);
  const api = createApiVue(client);
  t.after(() => api.dispose());
  const app = createApp({ render: () => null }); app.use(api);
  const scope = effectScope(); t.after(() => scope.stop());
  const resource = scope.run(() => app.runWithContext(() => useApiService("productos")));
  const file = await resource.export({ type: "csv", id: 2 });
  assert.equal(file.filename, "productos.csv");
  assert.match(await file.blob.text(), /Árbol/);
});

it("requires the export permission independently from list", async t => {
  const { api, url } = await fixture(t, { auth: { required: true, secret: "export-secret" } });
  const models = api.auth.models;
  await models.users.create({ id: "reader", password: "1234" });
  const role = await models.roles.create({ role: "reader" });
  await models.usersRoles.create({ userId: "reader", roleId: role.get("id") });
  const permission = await models.permissions.create({ permission: "productos.list" });
  await models.rolesPermissions.create({ roleId: role.get("id"), permissionId: permission.get("id") });
  const login = await (await fetch(`${url}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "reader", password: "1234" }) })).json();
  const headers = { Authorization: `Bearer ${login.data.token}` };
  assert.equal((await fetch(`${url}/productos`, { headers })).status, 200);
  assert.equal((await fetch(`${url}/productos/export`, { headers })).status, 403);
  assert.equal((await fetch(`${url}/productos/export`)).status, 401);
});

it("preserves download filenames and reports JSON errors when requesting a file", async t => {
  const client = createApiClient({ url: "http://server/api", changes: false, sse: false, pingInterval: 60_000,
    fetch: async url => {
      if (new URL(url).pathname === "/api/denied") return Response.json({ ok: false, message: "Sin permiso", code: "FORBIDDEN" }, { status: 403 });
      return new Response("contenido", { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=facturas.csv; filename*=UTF-8''facturaci%C3%B3n.csv" } });
    },
  });
  t.after(() => client.destroy());
  const file = await client.request("/file", { responseType: "blob", auth: false });
  assert.equal(file.filename, "facturación.csv");
  assert.equal(await file.blob.text(), "contenido");
  await assert.rejects(client.request("/denied", { responseType: "blob", auth: false }), error => error.status === 403 && error.message === "Sin permiso");
});
