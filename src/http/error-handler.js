import { AppError } from "../errors/app-error.js";
import { getContext } from "../context/request-context.js";
import { errorLogger } from "../logger/index.js";

export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;

  const ctx = getContext();
  const txId = ctx?.txId || req.headers["x-transaction-id"] || null;

  if (err instanceof AppError) {
    errorLogger(err, req, { txId, status: err.status, code: err.code, errors: err.errors });
    const body = err.toJSON();
    if (txId) body.txId = txId;
    if (err.headers) {
      for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
    }
    return res.status(err.status).json(body);
  }

  if (err.type === "entity.parse.failed") {
    errorLogger(err, req, { txId, status: 400, code: "INVALID_JSON" });
    return res.status(400).json({ ok: false, code: "INVALID_JSON", message: "JSON invalido", txId });
  }

  const status = err.status || err.statusCode || 500;
  errorLogger(err, req, { txId, status, code: "INTERNAL_ERROR" });
  const body = { ok: false, code: "INTERNAL_ERROR", message: process.env.NODE_ENV === "production" ? "Error interno" : err.message, txId };
  if (process.env.NODE_ENV !== "production") body.stack = err.stack;
  res.status(status).json(body);
}
