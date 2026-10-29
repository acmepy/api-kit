import assert from "node:assert/strict";
import { it } from "node:test";
import { createApiClient, createAdapter, MapAdapter } from "../src/client/index.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const schema = { schema: "1.0.0", services: [{ name: "items", tenant: { attribute: "tenantId" }, primaryKeyAttributes: ["id"], operations: {
  list: { path: "/api/items", method: "GET" }, create: { path: "/api/items", method: "POST" },
  update: { path: "/api/items/{id}", method: "PUT" }, remove: { path: "/api/items/{id}", method: "DELETE" },
}, schemas: {} }] };

function fixture(t, state = { tenantId: 1 }, options = {}) {
  const stores = new Map(), calls = [];
  const adapterFor = ({ service = "root" } = {}) => {
    if (!stores.has(service)) {
      const initial = service === "session" ? options.initialSession : service === "items" ? options.initialItem : null;
      stores.set(service, initial ? new MapAdapter(new Map([[initial.id, initial]])) : createAdapter({ type: "memory" }));
    }
    return stores.get(service);
  };
  const client = createApiClient({ url: "http://tenant/api", adapter: adapterFor(), createAdapter: adapterFor,
    changes: false, sse: false, serviceSyncDelay: false, pingInterval: 60_000, ...options,
    async fetch(url, init = {}) {
      const path = new URL(url).pathname;
      calls.push({ path, query: Object.fromEntries(new URL(url).searchParams), method: init.method || "GET", body: init.body && JSON.parse(init.body) });
      if (state.offline) throw new TypeError("Offline");
      if (state.intercept) {
        const response = state.intercept(path, init);
        if (response) return response;
      }
      const session = { id: "shared-session", token: "token", user: { id: "one", tenantId: 1 }, tenantId: state.tenantId };
      if (path.endsWith("/ping")) return json({ ok: true });
      if (path.endsWith("/login") || path.endsWith("/session")) return json({ ok: true, data: session });
      if (path.endsWith("/session/tenant")) {
        const { tenantId } = JSON.parse(init.body);
        if (![1, 2].includes(tenantId)) return json({ ok: false, code: "TENANT_FORBIDDEN", message: "Not allowed" }, 403);
        state.tenantId = tenantId;
        return json({ ok: true, data: { ...session, tenantId } });
      }
      if (path.endsWith("/schema.json")) return json(schema);
      if (path.endsWith("/sse")) return new Response(new ReadableStream({ start(controller) {
        (state.streams ||= []).push(controller);
        controller.enqueue(new TextEncoder().encode(": connected\n\n"));
      } }), { headers: { "Content-Type": "text/event-stream" } });
      if (path.endsWith("/report")) return json({ ok: true, data: { tenantId: state.tenantId } });
      if (path.endsWith("/items")) {
        if (init.method === "POST") return json({ ok: true, data: { ...JSON.parse(init.body), id: 99, tenantId: state.tenantId } });
        if (state.failReload && state.tenantId === 2) return json({ ok: false, message: "Reload failed" }, 500);
        return json({ ok: true, data: [{ id: state.tenantId, name: `Tenant ${state.tenantId}` }] });
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  t.after(() => client.destroy());
  return { client, calls, stores, state, async login() { await client.login({ username: "one", password: "old" }); } };
}

async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("Tenant transition did not finish");
}

it("tenant switch drains and rejects an old pull even when fetch ignores cancellation", async t => {
  const f = fixture(t); await f.login();
  await f.client.cachedRequest("report", "/report");
  const service = f.client.service("items");
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.state.intercept = path => {
    if (!path.endsWith("/items")) return;
    f.state.intercept = null;
    started();
    return new Promise(resolve => { release = resolve; });
  };
  const old = service.pull();
  const rejected = assert.rejects(old, { name: "AbortError" });
  await ready;
  const change = f.client.setSessionTenant(2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.client.tenantChanging(), true);
  assert.equal(f.calls.filter(call => call.path.endsWith("/session/tenant")).length, 0);
  release(json({ ok: true, data: [{ id: 100, name: "Old response" }] }));
  await rejected; await change;
  assert.deepEqual((await f.client.service("items").list()).data, [{ id: 2, name: "Tenant 2" }]);
  assert.equal(await f.client.adapter.get("cache:report"), null);
  await assert.rejects(() => service.create({ name: "Old handle" }), { code: "SERVICE_REPLACED" });
});

it("forbidden tenant keeps the old cache and a failed reload never restores old data", async t => {
  const f = fixture(t); await f.login();
  const oldService = f.client.service("items");
  await assert.rejects(() => f.client.setSessionTenant(3), { code: "TENANT_FORBIDDEN" });
  assert.equal((await f.client.session()).tenantId, 1);
  assert.equal(f.client.service("items"), oldService);
  assert.deepEqual((await oldService.list()).data, [{ id: 1, name: "Tenant 1" }]);
  f.state.failReload = true;
  await assert.rejects(() => f.client.setSessionTenant(2), /Reload failed/);
  assert.equal((await f.client.session()).tenantId, 2);
  assert.deepEqual((await f.client.service("items").list()).data, []);
});

function channels() {
  const first = { onmessage: null, close() {}, postMessage(data) { queueMicrotask(() => second.onmessage?.({ data })); } };
  const second = { onmessage: null, close() {}, postMessage(data) { queueMicrotask(() => first.onmessage?.({ data })); } };
  return [first, second];
}

it("connections sharing a session reload their caches after a tenant notification", async t => {
  const [a, b] = channels(), state = { tenantId: 1 };
  const first = fixture(t, state, { tenantChannel: a }), second = fixture(t, state, { tenantChannel: b });
  await first.login(); await second.login();
  await first.client.setSessionTenant(2);
  await waitFor(async () => !second.client.tenantChanging() && (await second.client.session()).tenantId === 2);
  assert.deepEqual((await second.client.service("items").list()).data, [{ id: 2, name: "Tenant 2" }]);
});

it("external tenant change preserves pending work and requires restoring its tenant before sending", async t => {
  const [a, b] = channels(), state = { tenantId: 1 };
  const first = fixture(t, state, { tenantChannel: a }), second = fixture(t, state, { tenantChannel: b });
  await first.login(); await second.login();
  state.offline = true;
  await assert.rejects(() => second.client.request("/items"));
  const service = second.client.service("items");
  await service.create({ name: "Pending" });
  state.offline = false;
  let conflict;
  second.client.onChange(event => { if (event.error?.code === "TENANT_CHANGED_WITH_PENDING") conflict = event.error; });
  await first.client.setSessionTenant(2);
  await waitFor(() => conflict);
  assert.equal((await service.pending()).data.length, 1);
  await assert.rejects(() => service.push(), { code: "TENANT_CHANGED_WITH_PENDING" });
  assert.equal(second.calls.filter(call => call.method === "POST" && call.path.endsWith("/items")).length, 0);
  await second.client.setSessionTenant(1);
  assert.equal((await service.pending()).data.length, 1);
  assert.equal((await service.push()).ok, true);
  assert.equal((await service.list()).data.find(row => row.id === 99).tenantId, 1);
  const sent = second.calls.find(call => call.method === "POST" && call.path.endsWith("/items"));
  assert.equal(sent.query.tenantId, "1");
  assert.equal(Object.hasOwn(sent.body, "pendingTenantId"), false);
});

it("a restarted client validates its persisted tenant before trusting old business caches", async t => {
  const f = fixture(t, { tenantId: 2 }, { initialSession: { id: "shared-session", token: "token", user: { id: "one" }, tenantId: 1 },
    initialItem: { id: 1, name: "Old cached company" } });
  await waitFor(async () => !f.client.tenantChanging() && (await f.client.session()).tenantId === 2);
  assert.deepEqual((await f.client.service("items").list()).data, [{ id: 2, name: "Tenant 2" }]);
  const sessionCheck = f.calls.findIndex(call => call.path.endsWith("/session"));
  const firstList = f.calls.findIndex(call => call.path.endsWith("/items"));
  assert.ok(sessionCheck >= 0 && firstList > sessionCheck);
});

it("SSE session closure clears the token immediately and preserves pending work", async t => {
  const f = fixture(t, { tenantId: 1 }, { sse: true });
  await f.login();
  f.state.offline = true;
  await assert.rejects(() => f.client.request("/items"));
  await f.client.service("items").create({ name: "Pending" });
  f.state.offline = false;
  await f.client.setSessionTenant(1);
  await waitFor(() => f.state.streams?.length >= 2);
  f.state.streams.at(-1).enqueue(new TextEncoder().encode("event: session-closed\ndata: {}\n\n"));
  await waitFor(async () => (await f.client.sessionService().adapter.getAll())[0]?.authExpired);
  assert.equal((await f.client.sessionService().adapter.getAll())[0].token, null);
  assert.equal((await f.client.service("items").pending()).data.length, 1);
});
