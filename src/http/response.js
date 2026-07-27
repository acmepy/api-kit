export function ok(data, meta = null) {
  const response = { ok: true, data };
  if (meta) response.meta = meta;
  return response;
}

export function list(data, pagination) {
  return { ok: true, data, pagination };
}
