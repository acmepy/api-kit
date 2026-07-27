import { getContext } from "../context/request-context.js";

let _logging = false;

export function setLogging(logging) {
  _logging = logging;
}

export function log(level, ...args) {
  if (!_logging) return;
  if (_logging === true) return console[level]?.("[api-kit]", ...args);
  if (typeof _logging === "function") return _logging("[api-kit]", level, ...args);
  if (typeof _logging === "object") return _logging[level]?.("[api-kit]", ...args);
}

export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  const ip = req.ip || req.socket?.remoteAddress || "";
  const userAgent = req.headers["user-agent"] || "";

  res.on("finish", () => {
    const ctx = getContext();
    const txId = ctx?.txId || req.headers["x-transaction-id"] || "";
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    log("info", "request", txId, ip, req.method, req.originalUrl, res.statusCode, Number(durationMs.toFixed(2)), res.getHeader("content-length") || 0, userAgent);
  });

  next();
}

export function errorLogger(err, req, { txId, status, code, errors }) {
  log(status >= 500 ? "error" : "warn", "http.error", {
    txId,
    status,
    code,
    message: err.message,
    errorName: err.name || err.constructor?.name || "Error",
    method: req.method,
    path: req.originalUrl || req.url,
    ...(errors && { errors }),
    ...(status >= 500 && err.stack && { stack: err.stack }),
  });
}
