export function mergeConfig(defaults, overrides) {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof defaults[key] === "object" && defaults[key] !== null && !Array.isArray(defaults[key])) {
      result[key] = mergeConfig(defaults[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
