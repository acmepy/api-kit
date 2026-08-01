import { BaseAdapter } from "./base-adapter.js";

export class LocalStorageAdapter extends BaseAdapter {
  #storage;

  constructor(storage = globalThis.localStorage) {
    super();
    if (!storage) throw new Error("LocalStorageAdapter requiere localStorage");
    this.#storage = storage;
  }

  async get(key) {
    const value = this.#storage.getItem(key);
    return value ? JSON.parse(value) : null;
  }

  async set(key, value) {
    this.#storage.setItem(key, JSON.stringify(value));
  }

  async remove(key) {
    this.#storage.removeItem(key);
  }
}
