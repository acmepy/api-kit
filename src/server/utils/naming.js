export function camelCase(str) {
  return str.replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^(.)/, (_, c) => c.toLowerCase());
}

export function snakeCase(str) {
  return String(str).replace(/([a-z])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
}

export function pascalCase(str) {
  const cc = camelCase(str);
  return cc.charAt(0).toUpperCase() + cc.slice(1);
}

export function kebabCase(str) {
  return str.replace(/([a-z])([A-Z])/g, "$1-$2").replace(/[\s_]+/g, "-").toLowerCase();
}

export function fileName(base, suffix, ext = "js") {
  return `${kebabCase(base)}.${suffix}.${ext}`;
}

export function applyNamingConvention(name, naming = {}) {
  let value = String(name || "");
  if (naming.tables === "snake_case") value = snakeCase(value);
  if (naming.tables === "camelCase") value = camelCase(value);
  if (naming.prefix && naming.tables) value = `${naming.prefix}_${value}`;
  if (naming.caseStyle === "upper") value = value.toUpperCase();
  if (naming.caseStyle === "lower") value = value.toLowerCase();
  return value;
}
