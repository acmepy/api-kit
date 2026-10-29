import { BaseAdapter } from "./base-adapter.js";

export class LocalStorageAdapter extends BaseAdapter {
  #storage;
  #key;
  #keyOf;

  constructor({ storage = globalThis.localStorage, service = "", prefix = "api", keyOf = (record) => record.id } = {}) {
    super();
    if (!storage) throw new Error("LocalStorageAdapter requiere localStorage");
    this.#storage = storage;
    this.#keyOf = keyOf;
    this.#key = service ? `${prefix}:${service}` : prefix;
  }

  async getAll() {
    return JSON.parse(this.#storage.getItem(this.#key) || "[]");
  }

  async get(key) {
    return (await this.getAll()).find((item) => this.#keyOf(item) === key) || null;
  }

  async add(value) {
    if (Array.isArray(value)) {
      const records = (await this.getAll()).filter((item) => !value.some((nextItem) => this.#keyOf(nextItem) === this.#keyOf(item)));
      const nextRecords = [...records,...value];
      this.#storage.setItem(this.#key, JSON.stringify(nextRecords));
      return value;
    }
    await this.put(this.#keyOf(value), value);
    return value;
  }

  async put(key, value) {
    const records = await this.getAll();
    const nextRecords = [...records.filter((item) => this.#keyOf(item) !== key), value];
    this.#storage.setItem(this.#key, JSON.stringify(nextRecords));
    return value;
  }

  async delete(key) {
    const records = await this.getAll();
    const nextRecords = records.filter((item) => this.#keyOf(item) !== key);
    this.#storage.setItem(this.#key, JSON.stringify(nextRecords));
  }

  async clear() {
    this.#storage.removeItem(this.#key);
  }
}
