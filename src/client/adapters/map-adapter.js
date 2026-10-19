import { BaseAdapter } from "./base-adapter.js";

export class MapAdapter extends BaseAdapter {
  #map;
  #keyOf;

  constructor(map = new Map(), keyOf = (record) => record.id) {
    super();
    this.#map = map;
    this.#keyOf = keyOf;
  }

  async getAll() {
    return [...this.#map.values()];
  }

  async get(key) {
    return this.#map.get(key) ?? null;
  }

  async add(value) {
    if(Array.isArray(value)) {
      value.forEach(v => this.put(this.#keyOf(v), v));
      return value;
    }
    this.put(this.#keyOf(value), value);
    return value;
  }

  async put(key, value) {
    this.#map.set(key, value);
    return value;
  }

  async delete(key) {
    return this.#map.delete(key);
  }

  async clear() {
    this.#map.clear();
  }
}
