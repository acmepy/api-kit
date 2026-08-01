export function encodeBody(body, headers) {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (typeof FormData !== "undefined" && body instanceof FormData) return body;
  headers["Content-Type"] = headers["Content-Type"] || "application/json";
  return JSON.stringify(body);
}
