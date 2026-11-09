import { it } from "node:test";
import assert from "node:assert/strict";
import { isReadonly, nextTick } from "vue";
import { createApiClient } from "../src/client/index.js";
import { createApiVue } from "../src/vue/index.js";

const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const gate = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for sync state");
}

async function fixture(t, fetchService, serviceSyncDelay = false) {
  const events = [];
  const client = createApiClient({ url: "http://server/api", changes: false, sse: false, serviceSyncDelay,
    pingInterval: 60000, fetch: async (address, options) => {
      const url = new URL(address);
      if (url.pathname === "/api/ping" || url.pathname === "/api/logout") return response({ ok: true });
      if (url.pathname === "/api/login") return response({ ok: true, data: {
        id: "session", token: "token", user: { id: JSON.parse(options.body).username },
      } });
      if (url.pathname === "/api/schema.json") return response({ schema: "1.0.0", services: ["clientes", "facturas"].map(name => ({
        name, operations: {
          list: { path: `/api/${name}`, method: "GET" }, create: { path: `/api/${name}`, method: "POST" },
          update: { path: `/api/${name}/{id}`, method: "PUT" }, remove: { path: `/api/${name}/{id}`, method: "DELETE" },
        },
      })) });
      return fetchService(url, options);
    },
  });
  t.after(() => client.destroy());
  client.onChange(event => { if (event.type === "sync") events.push(event); });
  await until(() => client.connected());
  return { client, events };
}

it("sync(true) reports each scheduled download and completes only after pagination and cache storage", async t => {
  const secondPage = gate();
  const cacheWrite = gate();
  let writing = false;
  const { client, events } = await fixture(t, async url => {
    if (url.pathname === "/api/facturas") return response({ ok: true, data: [] });
    if (url.searchParams.get("page") === "2") { await secondPage.promise; return response({ ok: true, data: [{ id: 3 }], pagination: { page: 2, total: 3, pages: 2 } }); }
    return response({ ok: true, data: [{ id: 1 }, { id: 2 }], pagination: { page: 1, total: 3, pages: 2 } });
  }, 0);
  await client.syncServices(true);
  const service = client.service("clientes");
  const add = service.adapter.add.bind(service.adapter);
  service.adapter.add = async records => { writing = true; await cacheWrite.promise; return add(records); };
  await until(() => client.syncState().find(state => state.service === "clientes")?.count === 2);
  assert.deepEqual(client.syncState().find(state => state.service === "clientes"), {
    service: "clientes", direction: "download", status: "downloading", count: 2, total: 3, succeeded: 0, failed: 0,
  });
  secondPage.resolve();
  await until(() => writing);
  assert.equal(client.syncState().find(state => state.service === "clientes").status, "downloading");
  cacheWrite.resolve();
  await until(() => client.syncState().find(state => state.service === "clientes")?.status === "completed");
  assert.equal((await service.list()).data.length, 3);
  const progress = events.filter(event => event.service === "clientes");
  assert.deepEqual(progress.map(event => event.status), ["starting", "downloading", "downloading", "downloading", "completed"]);
  assert.deepEqual(progress.map(event => event.count), [0, 0, 2, 3, 3]);
  assert.equal(progress.at(-1).succeeded, 3);
  assert.equal(client.syncState().find(state => state.service === "facturas").total, 0);
});

it("download errors are observable in client and Vue, and snapshots cannot modify client state", async t => {
  let fail = true;
  const { client } = await fixture(t, () => { if (fail) throw new TypeError("Failed to fetch"); return response({ ok: true, data: [{ id: 1 }] }); });
  await client.syncServices(true);
  const vue = createApiVue(client); t.after(() => vue.dispose());
  await assert.rejects(() => client.service("clientes").pull(), { code: "NETWORK_ERROR" });
  const snapshot = client.syncState();
  assert.equal(snapshot[0].status, "error");
  assert.equal(snapshot[0].error.code, "NETWORK_ERROR");
  assert.equal(snapshot[0].error.message, "Failed to fetch");
  snapshot[0].status = "completed";
  snapshot[0].error.message = "Changed by caller";
  snapshot.push({ service: "fake" });
  assert.equal(client.syncState().length, 1);
  assert.equal(client.syncState()[0].status, "error");
  assert.equal(client.syncState()[0].error.message, "Failed to fetch");
  await nextTick();
  assert.equal(vue.syncState.value[0].status, "error");
  assert.ok(isReadonly(vue.syncState));
  assert.ok(isReadonly(vue.syncState.value[0]));
  const lateVue = createApiVue(client); t.after(() => lateVue.dispose());
  assert.equal(lateVue.syncState.value[0].status, "error", "Late subscribers see current state");
  fail = false;
  await client.service("clientes").pull();
  assert.equal(client.syncState().length, 1, "Repeated runs replace the previous state");
  assert.equal(client.syncState()[0].error, undefined);
  assert.equal(vue.syncState.value[0].status, "completed");
  await client.logout();
  assert.deepEqual(client.syncState(), []);
  assert.deepEqual(vue.syncState.value, []);
});

it("uploads report progress and partial rejections, keep failed pending records and reset counts on retry", async t => {
  let reject = true;
  const second = gate();
  const { client, events } = await fixture(t, async (url, options) => {
    if (options.method === "GET") return response({ ok: true, data: [] });
    if (url.pathname === "/api/facturas/2" && reject) {
      await second.promise;
      return response({ ok: false, code: "VALIDATION_ERROR", message: "Invalid amount", errors: { importe: "Requerido" } }, 400);
    }
    return response({ ok: true, data: options.body ? JSON.parse(options.body) : { id: 3 } });
  });
  await client.syncServices(true);
  const service = client.service("facturas");
  await service.adapter.add([
    { id: 1, pending: true, operation: "create" },
    { id: 2, pending: true, operation: "update" },
    { id: 3, pending: true, operation: "remove" },
  ]);
  const sending = client.service("pending").push();
  await until(() => client.syncState().find(state => state.service === "facturas")?.count === 1);
  const inFlight = client.syncState().find(state => state.service === "facturas");
  assert.equal(inFlight.status, "uploading"); assert.equal(inFlight.total, 3); assert.equal(inFlight.succeeded, 1);
  second.resolve();
  const result = await sending;
  assert.equal(result.ok, false);
  const completed = client.syncState().find(state => state.service === "facturas");
  assert.deepEqual(completed, { service: "facturas", direction: "upload", status: "completed", count: 3, total: 3, succeeded: 2, failed: 1 });
  assert.deepEqual((await service.pending()).data.map(row => row.id), [2]);
  assert.deepEqual(events.filter(event => event.service === "facturas").map(event => event.count), [0, 0, 1, 2, 3, 3]);
  reject = false;
  await service.push();
  assert.deepEqual(client.syncState().find(state => state.service === "facturas"), {
    service: "facturas", direction: "upload", status: "completed", count: 1, total: 1, succeeded: 1, failed: 0,
  });
  await service.pull();
  assert.equal(client.syncState().filter(state => state.service === "facturas").length, 2, "Directions have independent states");
});

it("single pending uploads and fatal cache errors report the appropriate final state", async t => {
  const { client } = await fixture(t, (_url, options) => response({ ok: true, data: JSON.parse(options.body) }));
  await client.syncServices(true);
  const service = client.service("facturas");
  await service.adapter.add({ id: 1, pending: true, operation: "create" });
  const vue = createApiVue(client); t.after(() => vue.dispose());
  await service.pushOne((await service.get(1)).data);
  assert.equal(vue.syncState.value[0].succeeded, 1);
  service.adapter.getAll = async () => { throw new Error("Storage unavailable"); };
  await assert.rejects(() => service.push(), /Storage unavailable/);
  assert.equal(client.syncState()[0].status, "error");
  assert.equal(client.syncState()[0].error.message, "Storage unavailable");
  assert.equal(vue.syncState.value[0].status, "error");
});

it("older downloads and destroyed clients cannot overwrite the latest sync state", async t => {
  const older = gate();
  const ending = gate();
  let calls = 0;
  const { client } = await fixture(t, async () => {
    calls++;
    if (calls === 1) await older.promise;
    if (calls === 3) await ending.promise;
    return response({ ok: true, data: [{ id: calls }] });
  });
  await client.syncServices(true);
  const service = client.service("clientes");
  const first = service.pull();
  await until(() => calls === 1);
  await service.pull();
  const latest = client.syncState();
  older.resolve(); await first;
  assert.deepEqual(client.syncState(), latest);
  const vue = createApiVue(client); t.after(() => vue.dispose());
  const last = service.pull();
  await until(() => calls === 3);
  client.destroy();
  ending.resolve();
  await last.catch(() => {});
  assert.deepEqual(client.syncState(), []);
  assert.deepEqual(vue.syncState.value, []);
});

it("login preserves the same user's progress and clears it when another user logs in", async t => {
  const { client } = await fixture(t, () => response({ ok: true, data: [] }));
  await client.login({ username: "one" }, { sync: false });
  await client.syncServices(true);
  await client.service("clientes").pull();
  await client.login({ username: "one" }, { sync: false });
  assert.equal(client.syncState().length, 1);
  await client.login({ username: "two" }, { sync: false });
  assert.deepEqual(client.syncState(), []);
});
