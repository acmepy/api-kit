import { getContext } from "../context/request-context.js";

let _logging = false;

export function setLogging(logging) {
  _logging = logging;
}

export function log(level, path, ...args) {
  if (!_logging) return;
  const data = args.length === 1 && args[0] instanceof Error ? { error: args[0] }
    : args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0]) ? args[0]
      : args.length ? { data: args } : {};
  const txId = data.txId || getContext()?.txId;
  const seen = new WeakSet();
  const payload = JSON.stringify({ type: path, ...data, ...(txId && { txId }) }, (_key, value) => {
    if (typeof value === "bigint") return String(value);
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    if (value instanceof Error) return { name: value.name, message: value.message, code: value.code,
      errors: value.errors, details: value.details, stack: value.stack };
    return value;
  });
  const output = [...(txId ? [txId] : []), payload];
  if (_logging === true) return console[level]?.("[API]", ...output);
  if (typeof _logging === "function") return _logging("[API]", level, ...output);
  if (typeof _logging === "object" && typeof _logging[level] === "function") return _logging[level]("[API]", ...output);
}

export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  const ip = req.ip || req.socket?.remoteAddress || "";
  const userAgent = req.headers["user-agent"] || "";

  res.on("finish", () => {
    const ctx = getContext();
    const txId = ctx?.txId || req.headers["x-transaction-id"] || "";
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    log("info", "request", { txId, ip, method: req.method, path: req.originalUrl,
      status: res.statusCode, durationMs: Number(durationMs.toFixed(2)),
      contentLength: Number(res.getHeader("content-length") || 0), userAgent });
  });

  next();
}

export function errorLogger(err, req, { txId, status, code, errors }) {
  log(status >= 500 ? "error" : "warn", "http.error", {
    txId, status, method: req.method, path: req.originalUrl || req.url,
    error: { name: err.name || err.constructor?.name || "Error", message: err.message, code,
      errors, ...(err.details && { details: err.details }), ...(status >= 500 && err.stack && { stack: err.stack }) },
  });
}
