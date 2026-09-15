import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IndexedDbAdapter } from "../src/client/adapters/indexed-db-adapter.js";

describe("IndexedDbAdapter", () => {
  it("implements the BaseAdapter storage operations", async () => {
    const adapter = new IndexedDbAdapter({ indexedDB: memoryIndexedDb(), dbName: "test", storeName: "records" });

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

function memoryIndexedDb() {
  const stores = new Map();
  return {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          createObjectStore(name) {
            stores.set(name, new Map());
          },
          transaction(name) {
            const records = stores.get(name);
            return {
              objectStore() {
                return {
                  get: (key) => operation(() => records.get(key)),
                  getAll: () => operation(() => [...records.values()]),
                  put: (value, key) => operation(() => records.set(key, value)),
                  delete: (key) => operation(() => records.delete(key)),
                  clear: () => operation(() => records.clear()),
                };
              },
            };
          },
        };
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function operation(callback) {
  const request = {};
  queueMicrotask(() => {
    try {
      request.result = callback();
      request.onsuccess?.();
    } catch (error) {
      request.error = error;
      request.onerror?.();
    }
  });
  return request;
}
