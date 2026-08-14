export function fillPath(path, params = {}) {
  return path.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(params[key]));
}

export function joinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/g, "");
  const child = String(path || "").replace(/^\/+/g, "");
  if (!base) return `/${child}`;
  if (!child) return base || "/";
  return `${base}/${child}`;
}

export function normalizeTimeout(value, fallback) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : fallback;
}
