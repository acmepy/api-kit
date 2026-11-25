export function encodeBody(body, headers) {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (typeof FormData !== "undefined" && body instanceof FormData) return body;
  headers["Content-Type"] = headers["Content-Type"] || "application/json";
  return JSON.stringify(body);
}

export function downloadFilename(disposition = "") {
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) {
    try { return decodeURIComponent(encoded[1]); } catch { /* Use the plain filename below. */ }
  }
  const plain = disposition.match(/filename=(?:"((?:\\.|[^"\\])*)"|([^;]+))/i);
  return plain ? (plain[1] ?? plain[2].trim()).replace(/\\(.)/g, "$1") : null;
}
