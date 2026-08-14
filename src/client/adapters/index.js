import { MapAdapter } from "./map-adapter.js";
import { LocalStorageAdapter } from "./local-storage-adapter.js";
import { IndexedDbAdapter } from "./indexed-db-adapter.js";

export { BaseAdapter } from "./base-adapter.js";
export { MapAdapter } from "./map-adapter.js";
export { LocalStorageAdapter } from "./local-storage-adapter.js";
export { IndexedDbAdapter } from "./indexed-db-adapter.js";

export function createAdapter({ type, prefix = "api", service, ...options } = {}) {
  if (type === "localStorage") return new LocalStorageAdapter({ ...options, prefix, service });
  if (type === "indexedDB" || type === "indexdb") return new IndexedDbAdapter(options);
  return new MapAdapter();
}

export function defaultAdapter(options = {}) {
  const { storage, ...adapterOptions } = options;
  const storageType = typeof storage === "string" ? storage : undefined;
  const storageOption = storageType ? {} : { storage };
  return createAdapter({
    ...adapterOptions,
    ...storageOption,
    type: options.type || storageType,
    prefix: options.prefix || "api",
  });
}
