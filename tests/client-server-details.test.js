import { it } from "node:test";
import assert from "node:assert/strict";
import { createApp, effectScope } from "vue";
import { createApi } from "../src/server/index.js";
import { createApiClient } from "../src/client/index.js";
import { createApiVue, useApiForm, useApiService } from "../src/vue/index.js";
import { createTestSeq } from "./helpers/seq.js";

it("Vue and discovered client preserve nested details, server validation and native keys over HTTP", async () => {
  const seq = createTestSeq({ logging: false });
  const serverApi = await createApi({ seq, basePath: "/api", schema: true, modules: [{
    name: "listas", modelName: "Lista", timestamps: false,
    attributes: { codigo: { type: "string", primaryKey: true }, descripcion: { type: "string" } },
    details: [{ name: "items", modelName: "ListaItem", foreignKey: "codigo", timestamps: false,
      attributes: {
        codigo: { type: "string", primaryKey: true, allowNull: false },
        articulo: { type: "string", primaryKey: true, allowNull: false, regexp: /^[A-Z0-9]+$/ },
        cantidad: { type: "integer", allowNull: false, min: 1, positive: true },
      },
    }],
  }, {
    name: "parametros", modelName: "Parametro", timestamps: false,
    attributes: { id: { type: "integer", primaryKey: true }, sucursal: { type: "string", primaryKey: true }, valor: { type: "string" } },
  }] });
  await seq.authenticate();
  await seq.init();
  await seq.sync({ force: true });
  const server = await new Promise(resolve => {
    const listener = serverApi.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const client = createApiClient({ url: `http://127.0.0.1:${server.address().port}/api`, changes: false, sse: false, serviceSyncDelay: false });
  const vue = createApiVue(client);
  const app = createApp({ render: () => null });
  app.use(vue);
  const scope = effectScope();
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Ping timeout")), 2000);
      const off = client.onChange(() => { if (client.connected()) { clearTimeout(timeout); off(); resolve(); } });
    });
    await client.syncServices(true);
    const service = client.service("listas");
    assert.deepEqual(service.primaryKeyAttributes, ["codigo"]);
    assert.deepEqual(service.details.items.primaryKeyAttributes, ["codigo", "articulo"]);
    assert.ok(service.details.items.schemas.create);
    const invalidDetail = { articulo: "A!" }; // Missing required quantity and invalid article format.
    const checkDetailErrors = error => {
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.deepEqual(Object.keys(error.errors).sort(), ["articulo", "cantidad"]);
      assert.match(error.errors.cantidad, /requerido/);
      assert.match(error.errors.articulo, /formato/);
      return true;
    };
    await assert.rejects(() => service.validateDetail("items", invalidDetail), checkDetailErrors);
    await assert.rejects(() => service.validateDetailAt("items", "cantidad", invalidDetail), error => {
      assert.deepEqual(Object.keys(error.errors), ["cantidad"]);
      assert.match(error.errors.cantidad, /requerido/);
      return true;
    });
    await assert.rejects(() => service.validateDetailAt("items", "articulo", invalidDetail), error => {
      assert.deepEqual(Object.keys(error.errors), ["articulo"]);
      assert.match(error.errors.articulo, /formato/);
      return true;
    });
    await assert.rejects(() => client.request("/listas", { method: "POST", body: { codigo: "ERR", items: [invalidDetail] } }), error => {
      assert.equal(error.status, 400);
      assert.deepEqual(Object.keys(error.errors), ["ListaItem"]);
      return checkDetailErrors({ code: error.code, errors: error.errors.ListaItem });
    });
    assert.equal(await serverApi.services.get("listas").model.findByPk("ERR"), null, "Invalid detail rolls back its master");
    assert.deepEqual(await service.validateDetail("items", { articulo: "VALID", cantidad: "2" }), { articulo: "VALID", cantidad: 2 });
    assert.equal(await service.validateDetailAt("items", "cantidad", { cantidad: "3" }), 3);
    await assert.rejects(() => service.validateDetail("items", { articulo: "INVALID", cantidad: 0 }),
      error => typeof error.errors.cantidad === "string");
    assert.deepEqual(await service.validateDetail("items", {}, "update"), {});
    const form = scope.run(() => app.runWithContext(() => useApiForm("listas", {
      initial: { codigo: "001", descripcion: "Primera", items: [{ articulo: "A1", cantidad: "2" }] },
    })));
    const saved = await form.submit();
    const created = await service.get(saved.data.codigo);
    assert.equal(created.data.codigo, "001");
    assert.equal(created.data.items[0].cantidad, 2);
    assert.equal(created.data.items[0].codigo, "001");
    assert.equal(created.data.id, undefined);
    assert.equal((await service.get("001")).data.codigo, "001");
    const resource = scope.run(() => app.runWithContext(() => useApiService("listas")));
    await assert.rejects(() => resource.validateDetail("items", invalidDetail), checkDetailErrors);
    await assert.rejects(() => resource.validateDetailAt("items", "articulo", invalidDetail), error => {
      assert.match(error.errors.articulo, /formato/);
      return true;
    });
    await assert.rejects(() => resource.validateDetailAt("items", "cantidad", invalidDetail), error => {
      assert.match(error.errors.cantidad, /requerido/);
      return true;
    });
    assert.equal(await resource.validateDetailAt("items", "cantidad", { cantidad: "4" }), 4);
    assert.equal((await resource.validateDetail("items", { articulo: "A2", cantidad: "5" })).cantidad, 5);
    await assert.rejects(() => resource.validateDetailAt("items", "cantidad", { cantidad: 0 }),
      error => typeof error.errors.cantidad === "string");
    await resource.pull();
    await resource.updateDetail("001", "items", "A1", { cantidad: 3 });
    assert.equal(resource.records.value[0].items[0].cantidad, 3);
    await resource.createDetail("001", "items", { articulo: "A2", cantidad: 4 });
    assert.equal(resource.records.value[0].items.length, 2);
    await resource.removeDetail("001", "items", "A1");
    assert.deepEqual(resource.records.value[0].items.map(row => row.articulo), ["A2"]);
    form.reset({ codigo: "002", items: [{ articulo: "A1", cantidad: 0 }] });
    await assert.rejects(form.submit(), error => typeof error.errors?.ListaItem?.cantidad === "string");
    assert.equal(typeof form.errors.ListaItem.cantidad, "string");
    assert.match(form.errors.ListaItem.cantidad, / \| /, "Vue preserves multiple Yep messages for the same detail field");
    assert.equal(await serverApi.services.get("listas").model.findByPk("002"), null);
    const edit = scope.run(() => app.runWithContext(() => useApiForm("listas", {
      operation: "update", initial: { codigo: "001", descripcion: "Editada" },
    })));
    assert.equal((await edit.submit()).data.descripcion, "Editada");
    edit.reset({ codigo: "001", descripcion: "Reemplazada", items: [{ articulo: "A3", cantidad: "5" }] });
    await edit.submit();
    assert.equal((await service.get("001")).data.items[0].cantidad, 5);
    edit.reset({ codigo: "001", descripcion: "Invalida", items: [{ articulo: "A4", cantidad: 0 }] });
    await assert.rejects(edit.submit(), error => typeof error.errors?.ListaItem?.cantidad === "string");
    assert.equal(typeof edit.errors.ListaItem.cantidad, "string");
    await resource.pull();
    assert.equal(resource.records.value[0].descripcion, "Reemplazada");
    assert.equal(resource.records.value[0].items[0].articulo, "A3");

    const composite = client.service("parametros");
    for (const sucursal of ["001", "002"]) await composite.create({ id: 1, sucursal, valor: sucursal }, { pending: false });
    assert.equal((await composite.list()).data.length, 2);
    const key = { id: 1, sucursal: "001" };
    assert.equal(composite.keyOf(key), "1|001");
    assert.equal((await composite.get("1|001")).data.sucursal, "001");
    assert.equal((await composite.pullOne(key)).data.valor, "001");
    await composite.update(key, { valor: "nuevo" }, { pending: false });
    assert.equal((await composite.get(key)).data.valor, "nuevo");
    const compositeForm = scope.run(() => app.runWithContext(() => useApiForm("parametros", {
      operation: "update", initial: { ...key, valor: "Vue" },
    })));
    assert.equal((await compositeForm.submit()).data.valor, "Vue");
    assert.equal(composite.keyOf(compositeForm.data), "1|001");
    await assert.rejects(() => composite.pullOne("1|001"), /componentes/);
    await assert.rejects(composite.pullOne({ id: 1 }), /componentes/);
    await composite.remove(key, { pending: false });
    assert.equal((await composite.list()).data.length, 1);
    assert.equal((await composite.get({ id: 1, sucursal: "002" })).data.valor, "002");
  } finally {
    scope.stop();
    vue.dispose();
    client.destroy();
    await serverApi.close();
    await new Promise(resolve => server.close(resolve));
  }
});

