import { BaseAdapter } from "./base-adapter.js";

export class MapAdapter extends BaseAdapter {
  #map;

  constructor(map = new Map()) {
    super();
    this.#map = map;
  }

  async getAll() {
    return [...this.#map.values()];
  }

  async get(key) {
    return this.#map.get(key) ?? null;
  }

  async add(value) {
    if(Array.isArray(value)) {
      value.forEach(v => this.put(v.id, v));
      return value;
    }
    this.put(value.id, value);
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
