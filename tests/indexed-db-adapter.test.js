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
import { IDBFactory } from "fake-indexeddb";
import { createAdapter } from "../src/client/adapters/index.js";

it("stores services in one database and adds stores concurrently without losing records", { timeout: 5000 }, async () => {
  const indexedDB = new IDBFactory();
  const adapter = service => createAdapter({ type: "indexedDB", prefix: "vue", service, indexedDB });
  const auth = adapter("auth");
  await auth.put("session", { token: "token", pending: true });
  const names = ["parametros", "permisos", "personales", "proveedores"];
  const services = names.map(adapter);
  await Promise.all(services.map((service, i) => service.add({ id: 1, nombre: names[i] })));
  assert.deepEqual((await indexedDB.databases()).map(db => db.name), ["vue"]);
  const db = await openNative(indexedDB, "vue");
  assert.deepEqual([...db.objectStoreNames], ["auth", ...names].sort());
  db.close();
  assert.deepEqual(await auth.get("session"), { token: "token", pending: true });
  for (const [i, service] of services.entries()) {
    assert.deepEqual(await service.get(1), { id: 1, nombre: names[i] });
  }
  await services[0].clear();
  assert.deepEqual(await services[0].getAll(), []);
  assert.equal((await services[1].get(1)).nombre, "permisos");
  assert.equal((await adapter("auth").get("session")).pending, true);
});

it("upgrades an existing database and reopens its stores after another connection changes the version", { timeout: 5000 }, async () => {
  const indexedDB = new IDBFactory();
  const original = await openNative(indexedDB, "existing", 1, db => db.createObjectStore("session"));
  await new Promise((resolve, reject) => {
    const tx = original.transaction("session", "readwrite");
    tx.objectStore("session").put({ token: "kept" }, "session");
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  original.close();
  const adapter = storeName => new IndexedDbAdapter({ dbName: "existing", storeName, indexedDB });
  const session = adapter("session");
  const clients = adapter("clientes");
  await clients.add([{ id: 1, name: "Ana" }, { id: 2, name: "Beto" }]);
  assert.equal((await session.get("session")).token, "kept");
  const otherTab = await openNative(indexedDB, "existing", 3, db => db.createObjectStore("externo"));
  otherTab.close();
  await clients.put(1, { id: 1, name: "Ana Maria" });
  await clients.delete(2);
  assert.deepEqual(await clients.getAll(), [{ id: 1, name: "Ana Maria" }]);
  assert.equal((await session.get("session")).token, "kept");
});

it("recovers after an aborted transaction and respects a custom database name", { timeout: 5000 }, async () => {
  const indexedDB = new IDBFactory();
  const service = createAdapter({ type: "indexedDB", prefix: "ignored", dbName: "custom", service: "items", indexedDB });
  await assert.rejects(service.add([{ id: 1 }, { name: "missing key" }]), { name: "DataError" });
  assert.equal(await service.get(1), null);
  await service.add({ id: 2, name: "valid" });
  assert.equal((await service.get(2)).name, "valid");
  assert.deepEqual((await indexedDB.databases()).map(db => db.name), ["custom"]);
});

function openNative(factory, name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? factory.open(name) : factory.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

it("reports a blocked upgrade and retries without discarding existing stores", { timeout: 5000 }, async () => {
  const indexedDB = new IDBFactory();
  const external = await openNative(indexedDB, "blocked", 1, db => db.createObjectStore("session"));
  const adapter = new IndexedDbAdapter({ indexedDB, dbName: "blocked", storeName: "clientes" });
  try {
    await assert.rejects(adapter.add({ id: 1 }), /bloqueada por otra conexion/);
  } finally {
    external.close();
  }
  await adapter.add({ id: 2 });
  assert.deepEqual(await adapter.getAll(), [{ id: 2 }]);
  const db = await openNative(indexedDB, "blocked");
  assert.deepEqual([...db.objectStoreNames], ["clientes", "session"]);
  db.close();
});
