export function camelCase(str) {
  return str.replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^(.)/, (_, c) => c.toLowerCase());
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
