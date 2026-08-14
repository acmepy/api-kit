export function normalizeMountPath(value) {
  if (!value) return null;
  const clean = String(value).trim();
  if (!clean) return null;
  return clean.startsWith("/") ? clean.replace(/\/+$/g, "") || "/" : `/${clean.replace(/\/+$/g, "")}`;
}

export function normalizeMiddlewareOptions(value) {
  if (!value) return false;
  if (value === true) return true;
  return value;
}

export function normalizeTextOptions(value) {
  if (!value) return false;
  const defaults = { type: "text/plain", limit: "10mb" };
  if (value === true) return defaults;
  return { ...defaults, ...value };
}

export function normalizeStrategies(strategies = []) {
  return strategies.map((strategy) => (strategy === "jwt" ? "bearer" : strategy));
}

export function toIamStrategies(strategies = []) {
  return normalizeStrategies(strategies).map((strategy) => (strategy === "bearer" ? "jwt" : strategy));
}

export function normalizeGlobalAuth(auth) {
  if (!auth) return { required: false, strategies: [] };
  if (auth === true) return { required: true, strategies: ["bearer", "basic"], tokenExpiresIn: "1h" };
  const strategies = auth.strategies || auth.strategy || ["bearer", "basic"];
  return { ...auth, required: auth.required ?? true, strategies: Array.isArray(strategies) ? strategies : [strategies] };
}

export function normalizeAuthBackendConfig(auth) {
  if (!auth) return null;
  return {loginPath: "/login", sessionPath: "/session", logoutPath: "/logout", secret: process.env.IAM_SECRET || "api-dev-secret", tokenExpiresIn: auth?.tokenExpiresIn || "1h", adapter: auth?.adapter, models: auth?.models, ...auth};
}

export function normalizeJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  const normalized = Array.isArray(schema) ? schema.map((item) => normalizeJsonSchema(item)) : { ...schema };

  if (Array.isArray(normalized.type) && normalized.type.includes("null")) {
    const types = normalized.type.filter((type) => type !== "null");
    normalized.type = types.length === 1 ? types[0] : types;
    normalized.nullable = true;
  }

  if (normalized.properties) {
    normalized.properties = Object.fromEntries(
      Object.entries(normalized.properties).map(([key, value]) => [key, normalizeJsonSchema(value)]),
    );
  }

  if (normalized.items) normalized.items = normalizeJsonSchema(normalized.items);
  if (normalized.oneOf) normalized.oneOf = normalized.oneOf.map((item) => normalizeJsonSchema(item));
  if (normalized.anyOf) normalized.anyOf = normalized.anyOf.map((item) => normalizeJsonSchema(item));
  if (normalized.allOf) normalized.allOf = normalized.allOf.map((item) => normalizeJsonSchema(item));

  return normalized;
}
