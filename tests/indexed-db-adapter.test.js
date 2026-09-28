import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IndexedDbAdapter } from "../src/client/adapters/indexed-db-adapter.js";

describe("IndexedDbAdapter", () => {
  it("implements the BaseAdapter storage operations", async () => {
    const adapter = new IndexedDbAdapter({ idbKeyval: memoryKeyval(), dbName: "test", storeName: "records" });

    await adapter.add({ id: 1, name: "Ana" });
    await adapter.add([{ id: 2, name: "Beto" }]);
    await adapter.put(1, { id: 1, name: "Ana Maria" });

    assert.deepEqual(await adapter.get(1), { id: 1, name: "Ana Maria" });
    assert.deepEqual(await adapter.getAll(), [{ id: 1, name: "Ana Maria" }, { id: 2, name: "Beto" }]);

    await adapter.delete(1);
    assert.equal(await adapter.get(1), null);
    await adapter.clear();
    assert.deepEqual(await adapter.getAll(), []);
  });
});

function memoryKeyval() {
  const stores = new Map();
  return {
    createStore(dbName, storeName) {
      const key = `${dbName}:${storeName}`;
      if (!stores.has(key)) stores.set(key, new Map());
      return stores.get(key);
    },
    async values(store) { return [...store.values()]; },
    async get(key, store) { return store.get(key); },
    async set(key, value, store) { store.set(key, value); },
    async setMany(entries, store) { entries.forEach(([key, value]) => store.set(key, value)); },
    async del(key, store) { store.delete(key); },
    async clear(store) { store.clear(); },
  };
}
