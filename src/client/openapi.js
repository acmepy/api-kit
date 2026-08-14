const INTERNAL_SERVICES = new Set(["audit", "auth", "openapi", "postman", "session", "schema", "pending", "system", "install"]);

export function discoverServiceDescriptors(openapi, baseUrl = "") {
  const byName = new Map();
  const pathPrefix = String(baseUrl || "").replace(/\/+$/g, "");

  for (const [path, methods] of Object.entries(openapi?.paths || {})) {
    for (const [method, operation] of Object.entries(methods || {})) {
      const serviceName = operation.tags?.[0];
      const serviceMethod = serviceMethodFor(operation.operationId, serviceName);
      if (!serviceName || !serviceMethod || INTERNAL_SERVICES.has(serviceName)) continue;
      const clientPath = pathPrefix && path.startsWith(`${pathPrefix}/`) ? path.slice(pathPrefix.length) : path;
      if (!byName.has(serviceName)) byName.set(serviceName, { name: serviceName, path: clientPath, operations: {} });
      const descriptor = byName.get(serviceName);
      descriptor.operations[serviceMethod] = {method: method.toUpperCase(), path: clientPath, permissions: operation["x-permissions"] || []};
    }
  }
  return [...byName.values()];
}

function serviceMethodFor(operationId = "", serviceName = "") {
  const normalized = String(operationId).replace(`${serviceName}_`, `${serviceName}.`);
  const method = normalized.split(/[._-]/).pop();
  if (["list", "get", "schema", "create", "update", "remove", "changes", "sse"].includes(method)) return method;
  return method || null;
}

