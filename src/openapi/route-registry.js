export class RouteRegistry {
  #routes = new Map();

  register(descriptor) {
    const expressPath = descriptor.expressPath.replace(/\/+$/, "") || "/";
    const key = `${descriptor.method}:${expressPath}`;
    if (this.#routes.has(key)) throw new Error(`Duplicate route: ${descriptor.method.toUpperCase()} ${expressPath}`);
    this.#routes.set(key, { ...descriptor, expressPath });
  }

  getAll() {
    return [...this.#routes.values()];
  }

  findBy(filter) {
    return this.#routes.values().filter((d) => {
      for (const [k, v] of Object.entries(filter))  if (d[k] !== v) return false;
      return true;
    });
  }

  has(method, expressPath) {
    return this.#routes.has(`${method}:${expressPath}`);
  }

  clear() {
    this.#routes.clear();
  }

  get size() {
    return this.#routes.size;
  }
}
