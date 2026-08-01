import { MapAdapter } from "./map-adapter.js";
import { LocalStorageAdapter } from "./local-storage-adapter.js";
import { IndexedDbAdapter } from "./indexed-db-adapter.js";

export { BaseAdapter } from "./base-adapter.js";
export { MapAdapter } from "./map-adapter.js";
export { LocalStorageAdapter } from "./local-storage-adapter.js";
export { IndexedDbAdapter } from "./indexed-db-adapter.js";

export function defaultAdapter(options = {}) {
  if (options.storage === "localStorage") return new LocalStorageAdapter();
  if (options.storage === "indexedDB" || options.storage === "indexdb") return new IndexedDbAdapter();
  return new MapAdapter();
}
