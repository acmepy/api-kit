const INTERNAL_SERVICES = new Set(["audit", "auth", "postman", "session", "schema", "pending", "system", "install"]);

export function discoverServiceDescriptors(document, baseUrl = "") {
  if (!Array.isArray(document?.services)) return [];
  return document.services
    .filter((service) => !INTERNAL_SERVICES.has(service.name))
    .map((service) => schemaServiceDescriptor(service, baseUrl));
}

function schemaServiceDescriptor(service, baseUrl) {
  const pathPrefix = String(baseUrl || "").replace(/\/+$/g, "");
  const operations = Object.fromEntries(Object.entries(service.operations || {}).map(([name, operation]) => [name, {
    ...operation,
    path: stripPathPrefix(operation.path, pathPrefix),
  }]));
  return { ...service, path: operations.list?.path || Object.values(operations)[0]?.path || "", operations };
}

function stripPathPrefix(path, prefix) {
  return prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
}
