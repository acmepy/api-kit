import { BaseAdapter } from "./base-adapter.js";

export class IndexedDbAdapter extends BaseAdapter {
  #dbName;
  #storeName;
  #indexedDB;
  #dbPromise = null;

  constructor(options = {}) {
    super();
    this.#indexedDB = options.indexedDB || globalThis.indexedDB;
    if (!this.#indexedDB) throw new Error("IndexedDbAdapter requiere indexedDB");
    this.#dbName = options.dbName || "api-kit";
    this.#storeName = options.storeName || "session";
  }

  async get(key) {
    return this.#transaction("readonly", (store) => store.get(key));
  }

  async set(key, value) {
    await this.#transaction("readwrite", (store) => store.put(value, key));
  }

  async remove(key) {
    await this.#transaction("readwrite", (store) => store.delete(key));
  }

  async #transaction(mode, action) {
    const db = await this.#db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.#storeName, mode);
      const request = action(tx.objectStore(this.#storeName));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  #db() {
    if (this.#dbPromise) return this.#dbPromise;
    this.#dbPromise = new Promise((resolve, reject) => {
      const request = this.#indexedDB.open(this.#dbName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(this.#storeName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.#dbPromise;
  }
}
