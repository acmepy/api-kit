import * as idbKeyval from "idb-keyval";
import { BaseAdapter } from "./base-adapter.js";
import { sharedDatabaseStore } from "./indexed-db-store.js";

export class IndexedDbAdapter extends BaseAdapter {
  #keyval;
  #store;
  #keyOf;

  constructor(options = {}) {
    super();
    this.#keyOf = options.keyOf || ((record) => record.id);
    this.#keyval = options.idbKeyval || idbKeyval;
    const factory = options.indexedDB || globalThis.indexedDB;
    if (!options.idbKeyval && !factory) throw new Error("IndexedDbAdapter requiere indexedDB");
    const dbName = options.dbName || "api";
    const storeName = options.storeName || "session";
    this.#store = options.idbKeyval
      ? this.#keyval.createStore(dbName, storeName)
      : sharedDatabaseStore(factory, dbName, storeName);
  }

  async get(key) {
    return (await this.#keyval.get(key, this.#store)) ?? null;
  }

  async getAll() {
    return this.#keyval.values(this.#store);
  }

  async add(value) {
    if (Array.isArray(value)) {
      await this.#keyval.setMany(value.map((item) => [this.#keyOf(item), item]), this.#store);
      return value;
    }
    await this.put(this.#keyOf(value), value);
    return value;
  }

  async put(key, value) {
    await this.#keyval.set(key, value, this.#store);
    return value;
  }

  async delete(key) {
    await this.#keyval.del(key, this.#store);
  }

  async clear() {
    await this.#keyval.clear(this.#store);
  }
}
