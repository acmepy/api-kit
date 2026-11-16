import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { createApiClient } from "../src/client/index.js";
import { createApiVue } from "../src/vue/index.js";

function options(indexedDB) {
  return {
    url: "http://server/api", storage: "indexedDB", prefix: "session-test", indexedDB,
    changes: false, sse: false, serviceSyncDelay: false, pingInterval: 60_000,
    fetch: async url => new Response(JSON.stringify({ ok: true, data: String(url).endsWith("/login")
      ? { id: "server-session-id", token: "test-token", user: { id: "admin" } }
      : String(url).endsWith("/schema.json") ? undefined : {} ,
      ...(String(url).endsWith("/schema.json") && { schema: "1.0.0", services: [] }),
    }), { headers: { "Content-Type": "application/json" } }),
  };
}

test("session survives IndexedDB reload with metadata before the session record", async () => {
  const config = options(new IDBFactory());
  const client = createApiClient(config);
  try {
    await client.login({}, { sync: false });
    await client.adapter.put("cache:first", { id: "cache:first", data: {} });
    await client.markServiceCacheUpdated("recibos");
    assert.equal((await client.session()).token, "test-token");
    assert.equal((await client.sessionService().list()).data.id, "server-session-id");
  } finally { client.destroy(); }
  const restored = createApiClient(config);
  const vue = createApiVue(restored);
  try {
    await vue.initialized;
    assert.equal(vue.ready.value, true);
    assert.equal(vue.session.value.token, "test-token");
    assert.equal(vue.session.value.id, "server-session-id");
    assert.ok(await restored.adapter.get("cache:first"));
    assert.ok(await restored.adapter.get("sync:recibos"));
  } finally { vue.dispose(); restored.destroy(); }
});

for (const expired of [false, true]) {
  test(`reads legacy session keyed by server id with authExpired=${expired}`, async () => {
    const config = options(new IDBFactory());
    const client = createApiClient(config);
    const session = { id: "legacy-session", token: expired ? null : "test-token", authExpired: expired, user: { id: "admin" } };
    try {
      await client.adapter.put("cache:first", { id: "cache:first" });
      await client.sessionService().adapter.add(session);
      assert.deepEqual((await client.sessionService().list()).data, session);
      assert.deepEqual(await client.session(), expired ? {} : session);
      assert.ok(await client.adapter.get("cache:first"));
    } finally { client.destroy(); }
  });
}
