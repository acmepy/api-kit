export function joinPaths(...parts) {
  const clean = parts.filter((part) => part !== undefined && part !== null && part !== "").map((part) => String(part).trim()).filter(Boolean);
  if (clean.length === 0) return "/";
  const path = clean.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  return `/${path}`;
}
