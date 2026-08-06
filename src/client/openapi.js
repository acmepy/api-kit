import { fallbackOrigin } from "./utils.js";

export function discoverServiceDescriptors(openapi, baseUrl = "") {
  const byName = new Map();
  const pathPrefix = pathnamePrefix(baseUrl);

  for (const [path, methods] of Object.entries(openapi?.paths || {})) {
    for (const [method, operation] of Object.entries(methods || {})) {
      const serviceName = operation.tags?.[0];
      const serviceMethod = serviceMethodFor(operation.operationId, serviceName);
      if (!serviceName || !serviceMethod || serviceName === "auth" || serviceName === "openapi") continue;

      const clientPath = stripPathPrefix(path, pathPrefix);
      if (!byName.has(serviceName)) {
        byName.set(serviceName, { name: serviceName, path: basePathFor(clientPath), operations: {} });
      }

      const descriptor = byName.get(serviceName);
      descriptor.operations[serviceMethod] = {
        method: method.toUpperCase(),
        path: clientPath,
        permissions: operation["x-permissions"] || [],
      };
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

function basePathFor(path) {
  return path.replace(/\/\{[^}]+\}/g, "");
}

function pathnamePrefix(baseUrl) {
  try {
    const url = new URL(baseUrl, fallbackOrigin());
    return url.pathname === "/" ? "" : url.pathname.replace(/\/+$/g, "");
  } catch {
    return "";
  }
}

function stripPathPrefix(path, prefix) {
  if (!prefix || path === prefix) return path;
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) || "/" : path;
}
