import { AppError } from "../errors/app-error.js";
import { getContext } from "../context/request-context.js";

export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;

  const ctx = getContext();
  const txId = ctx?.txId || req.headers["x-transaction-id"] || null;

  if (err instanceof AppError) {
    const body = err.toJSON();
    if (txId) body.txId = txId;
    return res.status(err.status).json(body);
  }

  if (err.type === "entity.parse.failed") return res.status(400).json({ok: false, code: "INVALID_JSON", message: "JSON inválido", txId,});
  const status = err.status || err.statusCode || 500;
  const body = { ok: false, code: "INTERNAL_ERROR", message: process.env.NODE_ENV === "production" ? "Error interno" : err.message, txId,};
  if (process.env.NODE_ENV !== "production") body.stack = err.stack;
  res.status(status).json(body);
}
