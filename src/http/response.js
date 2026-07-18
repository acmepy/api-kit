export function ok(data, meta = null) {
  const response = { ok: true, data };
  if (meta) response.meta = meta;
  return response;
}

export function list(data, pagination) {
  return { ok: true, data, pagination };
}

export function error(code, message, { errors = null, txId = null } = {}) {
  const response = { ok: false, code, message };
  if (errors) response.errors = errors;
  if (txId) response.txId = txId;
  return response;
}
