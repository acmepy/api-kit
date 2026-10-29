import express from "express";
import { createLogReader, LogFileError } from "./reader.js";
import { renderPage, stylesheet, bootstrapStylesheet } from "./page.js";
import { viewerBrowser } from "./browser.js";

export { parseLogLine } from "./parser.js";

/** Standalone Express router: the host chooses its mount point and authorization. */
export function createLogViewer(options = {}) {
  const reader = createLogReader(options);
  const pageSize = options.pageSize ?? 200;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new TypeError("pageSize debe estar entre 1 y 500");
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/assets/viewer.css", (_req, res) => res.type("css").send(stylesheet));
  router.get("/assets/bootstrap.min.css", (_req, res) => res.type("css").send(bootstrapStylesheet));
  router.get("/assets/viewer.js", (_req, res) => res.type("js").send(`(${viewerBrowser.toString()})();`));
  router.get("/", (req, res) => res.type("html").send(renderPage(req.baseUrl, "files")));
  router.get("/view", (req, res) => res.type("html").send(renderPage(req.baseUrl, "view")));
  router.get("/api/files", async (_req, res) => res.json({ files: await reader.files() }));
  router.get("/api/entries", async (req, res) => {
    const file = stringQuery(req.query, "file");
    const level = stringQuery(req.query, "level");
    const source = stringQuery(req.query, "source");
    const txId = stringQuery(req.query, "txId");
    const before = numberQuery(req.query, "before");
    const limit = numberQuery(req.query, "limit", 500) ?? pageSize;
    res.json(await reader.entries(file, { level, source, txId, before, limit }));
  });
  router.use((error, _req, res, _next) => {
    const status = error instanceof LogFileError ? error.status : error.code === "ENOENT" ? 404 : error.code === "EACCES" ? 403 : 500;
    const message = error instanceof LogFileError ? error.message : status === 404 ? "Archivo o directorio no encontrado" : status === 403 ? "No se puede leer el archivo" : "No se pudo leer el log";
    res.status(status).json({ ok: false, message });
  });
  return router;
}

function stringQuery(query, key) {
  const value = query[key];
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 512) throw new LogFileError(`Filtro ${key} no valido`, 400);
  return value;
}
function numberQuery(query, key, max = Number.MAX_SAFE_INTEGER) {
  if (query[key] === undefined) return undefined;
  const value = stringQuery(query, key);
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max) throw new LogFileError(`Filtro ${key} no valido`, 400);
  return number;
}
export { version } from "../version.js";
