import * as idbKeyval from "idb-keyval";
import { BaseAdapter } from "./base-adapter.js";

export class IndexedDbAdapter extends BaseAdapter {
  #keyval;
  #store;

  constructor(options = {}) {
    super();
    this.#keyval = options.idbKeyval || idbKeyval;
    if (!options.idbKeyval && !globalThis.indexedDB) throw new Error("IndexedDbAdapter requiere indexedDB");
    this.#store = this.#keyval.createStore(options.dbName || "api", options.storeName || "session");
  }

  async get(key) {
    return (await this.#keyval.get(key, this.#store)) ?? null;
  }

  async getAll() {
    return this.#keyval.values(this.#store);
  }

  async add(value) {
    if (Array.isArray(value)) {
      await this.#keyval.setMany(value.map((item) => [item.id, item]), this.#store);
      return value;
    }
    await this.put(value.id, value);
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
