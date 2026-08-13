import { getContext } from "../context/request-context.js";
import { errorLogger } from "../logger/index.js";

export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;

  const txId = getContext()?.txId || req.headers["x-transaction-id"] || null;
  const status = err.status || err.statusCode || 500;
  const code = err.type === "entity.parse.failed" ? "INVALID_JSON" : err.code || "INTERNAL_ERROR";
  const errors = err.errors && typeof err.errors === "object" ? err.errors : {};
  const message = status >= 500 && process.env.NODE_ENV === "production" ? "Error interno" : err.message;

  errorLogger(err, req, { txId, status, code, message: err.message, errors, stack: status >= 500 ? err.stack : {} });

  const body = { ok: false, code, message, errors, txId };
  if (process.env.NODE_ENV !== "production") body.stack = err.stack;

  res.status(status).json(body);
}
