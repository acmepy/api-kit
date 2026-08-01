import { BaseAdapter } from "./base-adapter.js";

export class MapAdapter extends BaseAdapter {
  #map;

  constructor(map = new Map()) {
    super();
    this.#map = map;
  }

  async get(key) {
    return this.#map.get(key);
  }

  async set(key, value) {
    this.#map.set(key, value);
  }

  async remove(key) {
    this.#map.delete(key);
  }
}
