import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp, effectScope, nextTick } from "vue";
import { createApiVue, useApi, useApiService } from "../src/vue/index.js";

describe("Vue client layer", () => {
  it("provides reactive client state and mirrors a service cache", async () => {
    const records = [{ id: 1, nombre: "Ana" }];
    const listeners = new Set();
    const client = {
      connected: () => true,
      lastReceivedAt: () => null,
      session: async () => ({ token: "token" }),
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      service(name) {
        assert.equal(name, "clientes");
        return {
          list: async () => ({ ok: true, data: [...records] }),
          create: async (data) => {
            records.push({ id: 2, ...data });
            return { ok: true, data };
          },
        };
      },
    };
    const api = createApiVue(client);
    const app = createApp({ render: () => null });
    app.use(api);
    const scope = effectScope();
    const resource = scope.run(() => app.runWithContext(() => {
      assert.equal(useApi(), api);
      return useApiService("clientes");
    }));

    await nextTick();
    await resource.refresh();
    assert.deepEqual(resource.records.value, [{ id: 1, nombre: "Ana" }]);
    assert.equal(api.connected.value, true);
    assert.deepEqual(api.session.value, { token: "token" });

    await resource.create({ nombre: "Beto" });
    assert.deepEqual(resource.records.value, [{ id: 1, nombre: "Ana" }, { id: 2, nombre: "Beto" }]);

    records.push({ id: 3, nombre: "Cora" });
    for (const listener of listeners) listener({ type: "sse", lastReceivedAt: "2026-01-01T00:00:00.000Z" });
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(resource.records.value.length, 3);
    assert.equal(api.lastReceivedAt.value, "2026-01-01T00:00:00.000Z");

    scope.stop();
    api.dispose();
  });
});
