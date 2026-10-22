import { it } from "node:test";
import assert from "node:assert/strict";
import { BaseService } from "../src/client/services/base-service.js";
import { createAdapter } from "../src/client/adapters/index.js";

for (const type of ["memory", "localStorage", "indexedDB"]) {
  it(`${type} keeps native composite keys distinct through offline CRUD, push and SSE`, async () => {
    let online = false;
    const calls = [];
    const storage = new Map();
    const idbKeyval = {
      createStore: () => new Map(),
      values: async store => [...store.values()], get: async (key, store) => store.get(key),
      set: async (key, value, store) => { store.set(key, value); },
      setMany: async (entries, store) => { entries.forEach(([key, value]) => store.set(key, value)); },
      del: async (key, store) => { store.delete(key); }, clear: async store => { store.clear(); },
    };
    const service = new BaseService({
      name: "items", primaryKeyAttributes: ["lista", "articulo"], details: { extras: {} },
      client: { connected: () => online, request: async (path, options) => {
        calls.push({ path, ...options }); return { ok: true, data: options.body };
      } },
      operations: { create: { path: "/items", method: "POST" }, update: { path: "/items/{id}", method: "PUT" }, remove: { path: "/items/{id}", method: "DELETE" } },
      createAdapter: options => createAdapter({ ...options, type, idbKeyval,
        storage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
      }),
    });
    await service.save({ lista: "001", articulo: "A1", precio: 10, extras: [{ codigo: "01" }] });
    await service.save({ lista: "002", articulo: "A1", precio: 20 });
    assert.equal((await service.list()).data.length, 2);
    const key = { lista: "001", articulo: "A1" };
    assert.equal((await service.get(key)).data.id, undefined);
    online = true;
    await service.push(key);
    assert.equal(calls[0].body.lista, "001");
    assert.deepEqual(calls[0].body.extras, [{ codigo: "01" }]);
    online = false;
    const other = { lista: "002", articulo: "A1" };
    await service.save({ ...other, precio: 30 });
    online = true;
    await service.push(other);
    assert.equal(calls[1].path, "/items");
    assert.equal(calls[1].method, "POST");
    assert.deepEqual(calls[1].body, { ...other, precio: 30 });
    await service.save({ ...other, precio: 35 }, { pending: true });
    assert.equal(calls[2].path, "/items/002");
    assert.equal(calls[2].method, "PUT");
    assert.deepEqual(calls[2].query, other);
    await service.applyData({ action: "update", old: other, new: { precio: 40 } });
    assert.equal((await service.get(other)).data.precio, 40);
    online = false;
    await service.remove(other);
    online = true;
    await service.push(other);
    assert.equal(calls[3].method, "DELETE");
    assert.deepEqual(calls[3].query, other);
    await service.applyData({ action: "delete", old: other });
    assert.equal((await service.list()).data.length, 1);
    await service.applyData({ action: "delete", old: key });
    assert.deepEqual((await service.list()).data, []);
    online = false;
    await service.create({ ...other, precio: 50 });
    online = true;
    await service.remove(other);
    assert.deepEqual((await service.list()).data, []);
    assert.equal(calls.length, 4);
  });
}
