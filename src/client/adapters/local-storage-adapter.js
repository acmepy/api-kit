import { BaseAdapter } from "./base-adapter.js";

export class LocalStorageAdapter extends BaseAdapter {
  #storage;
  #key;
  #data;

  constructor({ storage = globalThis.localStorage, service = "", prefix = "api-kit" } = {}) {
    super();
    if (!storage) throw new Error("LocalStorageAdapter requiere localStorage");
    this.#storage = storage;
    this.#key = service ? `${prefix}:${service}` : prefix;
  }

  async getAll() {
    if(!this.#data) this.#data = JSON.parse(this.#storage.getItem(this.#key) || "[]");
    return this.#data;
  }

  async get(key) {
    return (await this.getAll()).find((item) => item?.id === key) || null;
  }

  async add(value) {
    if (Array.isArray(value)) {
      const records = (await this.getAll()).filter((item) => !value.some((nextItem) => nextItem?.id === item?.id));
      const nextRecords = [...records,...value];
      this.#storage.setItem(this.#key, JSON.stringify(nextRecords));
      this.#data = undefined;
      return value;
    }
    await this.put(value.id, value);
    return value;
  }

  async put(key, value) {
    const records = await this.getAll();
    const nextRecords = [...records.filter((item) => item?.id !== key), value];
    this.#storage.setItem(this.#key, JSON.stringify(nextRecords));
    this.#data = undefined;
    return value;
  }

  async delete(key) {
    const records = await this.getAll();
    const nextRecords = records.filter((item) => item?.id !== key);
    this.#storage.setItem(this.#key, JSON.stringify(nextRecords));
    this.#data = undefined;
  }

  async clear() {
    this.#data = undefined;
    this.#storage.removeItem(this.#key);
  }
}
