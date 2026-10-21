import express from 'express';
import { open, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HEADER = /^\[(?<timestamp>\d{4}-\d{2}-\d{2}[ T][^\]]+)\]\s*\[(?<level>[A-Z]+)\]\s*(?:\[(?<source>[^\]]+)\]\s*)?(?<message>.*)$/i;
const BARE_TX = new RegExp(`^(?:\\[(${UUID})\\]|(${UUID}))(?:\\s|$)`, "i");
const JSON_TX = /"txId"\s*:\s*"((?:\\.|[^"\\])*)"/;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function extractTxId(text) {
  const json = JSON_TX.exec(text);
  if (json) {
    try { return JSON.parse(`"${json[1]}"`); } catch { /* Keep looking in the prefix. */ }
  }
  const match = BARE_TX.exec(text);
  return match?.[1] || match?.[2] || null;
}

/** Returns null for continuation lines; never associates unrelated entries by time. */
function parseLogLine(line) {
  const clean = line.replace(ANSI, "");
  const match = HEADER.exec(clean);
  if (!match) return null;
  const { timestamp, level, source } = match.groups;
  let { message } = match.groups;
  let scope = null;
  const bracket = /^\[([^\]]+)\]\s*/.exec(message);
  if (bracket && !BARE_TX.test(bracket[0])) {
    scope = bracket[1];
    message = message.slice(bracket[0].length);
  }
  const txId = extractTxId(message);
  const leading = BARE_TX.exec(message);
  if (leading) message = message.slice(leading[0].length);
  return { timestamp, level: level.toUpperCase(), source: source || "Sin origen", scope, txId, message };
}

class LogFileError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function createLogReader({ directory, parseLine = parseLogLine } = {}) {
  if (typeof directory !== "string" || !directory) throw new TypeError("El visor requiere directory");
  const configuredRoot = path.resolve(directory);

  async function resolveFile(name) {
    if (typeof name !== "string" || !name || /[\\/\0:]/.test(name) || name === "." || name === ".." || !/\.log$/i.test(name)) {
      throw new LogFileError("Archivo de log no valido", 400);
    }
    const root = await realpath(configuredRoot);
    const target = await realpath(path.join(root, name));
    if (path.dirname(target) !== root) throw new LogFileError("Archivo fuera del directorio de logs", 403);
    return { root, target };
  }

  async function files() {
    const root = await realpath(configuredRoot);
    const entries = await readdir(root, { withFileTypes: true });
    const found = await Promise.all(entries.filter(entry => entry.isFile() && /\.log$/i.test(entry.name)).map(async entry => {
      try {
        const info = await stat(path.join(root, entry.name));
        return { name: entry.name, size: info.size, modifiedAt: info.mtime.toISOString() };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }));
    return found.filter(Boolean).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
  }

  async function entries(name, { level = "", source = "", txId = "", before, limit = 200 } = {}) {
    const { target } = await resolveFile(name);
    const handle = await open(target, "r");
    let lines;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new LogFileError("Archivo de log no valido", 400);
      const levels = new Set();
      const sources = new Set();
      const byLevel = {};
      const transactions = new Map();
      let withoutTxId = 0;
      const selected = [];
      let total = 0;
      let matched = 0;
      let eligible = 0;
      let lineNumber = 0;
      let current = null;
      const consume = () => {
        if (!current) return;
        current.txId ||= extractTxId(current.raw);
        total++;
        levels.add(current.level);
        sources.add(current.source);
        byLevel[current.level] = (byLevel[current.level] || 0) + 1;
        if (current.txId) {
          const key = current.txId.toLowerCase();
          let transaction = transactions.get(key);
          if (!transaction) {
            transaction = { txId: current.txId, count: 0, errorCount: 0, firstLine: current.line, lastLine: current.line, timestamp: current.timestamp };
            transactions.set(key, transaction);
          }
          transaction.count++;
          if (["ERROR", "FATAL"].includes(current.level)) transaction.errorCount++;
          transaction.lastLine = current.line;
          transaction.timestamp = current.timestamp;
        } else {
          withoutTxId++;
        }
        if (level && current.level !== level.toUpperCase()) return;
        if (source && current.source !== source) return;
        if (txId && current.txId?.toLowerCase() !== txId.toLowerCase()) return;
        matched++;
        if (before && current.line >= before) return;
        eligible++;
        // Bounded memory: only retain one page, even for a large log file.
        if (selected.length === limit) selected.shift();
        selected.push(current);
      };
      if (info.size > 0) {
        const stream = handle.createReadStream({ encoding: "utf8", autoClose: false, start: 0, end: info.size - 1 });
        lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            lineNumber++;
            const parsed = parseLine(line);
            if (parsed) {
              consume();
              current = { ...parsed, raw: line, line: lineNumber, endLine: lineNumber };
            } else if (current) {
              current.raw += `\n${line}`;
              current.message += `\n${line}`;
              current.endLine = lineNumber;
            } else if (line.trim()) {
              current = { timestamp: null, level: "UNKNOWN", source: "Sin origen", scope: null, txId: null, message: line, raw: line, line: lineNumber, endLine: lineNumber };
            }
          }
        } finally { lines.close(); stream.destroy(); }
      }
      consume();
      return {
        file: { name, size: info.size, modifiedAt: info.mtime.toISOString() },
        entries: selected.reverse(), total, matched,
        facets: { levels: [...levels].sort(), sources: [...sources].sort() },
        summary: { byLevel, transactions: transactions.size, withoutTxId },
        transactions: [...transactions.values()].sort((a, b) => b.lastLine - a.lastLine),
        nextCursor: eligible > limit ? selected.at(-1).line : null,
      };
    } finally { await handle.close(); }
  }
  return { files, entries };
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

const assets = new URL("./assets/", import.meta.url);
const pages = {
  files: readFileSync(new URL("log-index.html", assets), "utf8"),
  view: readFileSync(new URL("log-view.html", assets), "utf8"),
};

function renderPage(base, page) {
  return pages[page].replaceAll("{{base}}", () => escape(base));
}

const stylesheet = readFileSync(new URL("viewer.css", assets), "utf8");
const bootstrapStylesheet = readFileSync(new URL("bootstrap.min.css", assets), "utf8");

function viewerBrowser() {
  const base = document.body.dataset.base;
  const page = document.body.dataset.page;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const file = params.get("file") || "";
  let request = null;
  let cursor = null;
  let nextCursor = null;
  const history = [];
  let metadata = null;
  let timer;
  let transactionLimit = 100;

  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const bytes = value => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
  async function get(endpoint, query) {
    request?.abort();
    request = new AbortController();
    const response = await fetch(`${base}${endpoint}${query ? `?${query}` : ""}`, { signal: request.signal, headers: { Accept: "application/json" } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "No se pudo cargar el log");
    return result;
  }
  function error(cause) {
    if (cause.name === "AbortError") return;
    $("error").textContent = cause.message;
    $("error").hidden = false;
    $("status").textContent = "No se pudo actualizar";
  }
  function options(id, values) {
    const select = $(id);
    const value = select.value;
    select.replaceChildren(new Option(id === "level" ? "Todos los niveles" : "Todos los orígenes", ""));
    for (const item of values) select.add(new Option(item, item));
    if (value && !values.includes(value)) select.add(new Option(value, value));
    select.value = value;
  }
  async function files() {
    $("error").hidden = true;
    $("status").textContent = "Buscando archivos…";
    try {
      const result = await get("/api/files");
      $("files").replaceChildren();
      $("file-count").textContent = result.files.length;
      $("status").textContent = `${result.files.length} ${result.files.length === 1 ? "archivo disponible" : "archivos disponibles"}`;
      $("empty").hidden = result.files.length > 0;
      for (const file of result.files) {
        const link = node("a", undefined, "file-card card flex-row");
        link.href = `${base}/view?${new URLSearchParams({ file: file.name })}`;
        const icon = node("span", "\u21b3", "file-icon");
        const content = node("div");
        content.append(node("h2", file.name), node("p", `${bytes(file.size)} · Modificado ${new Date(file.modifiedAt).toLocaleString()}`));
        link.append(icon, content, node("span", "Abrir \u2192", "file-open"));
        $("files").append(link);
      }
    } catch (cause) { error(cause); }
  }
  function filterTransaction(txId) {
    $("txId").value = txId;
    restart();
    $("txId").focus();
  }
  function renderSummary(result) {
    const levels = [...new Set(["ERROR", "INFO", "TRACE", ...result.facets.levels])];
    $("level-summary").replaceChildren(...levels.map(level => {
      const button = node("button", undefined, `level-card card btn level-card-${level.toLowerCase()}`);
      button.type = "button";
      button.setAttribute("aria-pressed", String($("level").value === level));
      button.append(node("span", level), node("strong", (result.summary.byLevel[level] || 0).toLocaleString()));
      button.title = `Filtrar por ${level}`;
      button.addEventListener("click", () => {
        const value = $("level").value === level ? "" : level;
        if (value && ![...$("level").options].some(option => option.value === value)) {
          $("level").add(new Option(level, level));
        }
        $("level").value = value;
        restart();
      });
      return button;
    }));
    $("tx-total").textContent = result.summary.transactions.toLocaleString();
    $("tx-unassigned").textContent = `${result.summary.withoutTxId.toLocaleString()} entradas sin txId`;
    renderTransactions();
  }
  function renderTransactions() {
    if (!metadata) return;
    const search = $("tx-search").value.trim().toLowerCase();
    const onlyErrors = $("tx-errors-only").checked;
    const transactions = metadata.transactions.filter(transaction => (
      (!search || transaction.txId.toLowerCase().includes(search)) && (!onlyErrors || transaction.errorCount > 0)
    ));
    $("tx-list").replaceChildren(...transactions.slice(0, transactionLimit).map(transaction => {
      const button = node("button", undefined, "transaction list-group-item list-group-item-action");
      button.type = "button";
      button.title = transaction.txId;
      button.setAttribute("aria-pressed", String(transaction.txId.toLowerCase() === $("txId").value.toLowerCase()));
      const details = node("span", undefined, "transaction-meta");
      details.append(node("span", `${transaction.count} ${transaction.count === 1 ? "entrada" : "entradas"}`));
      if (transaction.errorCount) details.append(node("span", `${transaction.errorCount} ${transaction.errorCount === 1 ? "error" : "errores"}`, "transaction-errors"));
      button.append(node("code", transaction.txId), details);
      if (transaction.timestamp) button.append(node("small", transaction.timestamp));
      button.addEventListener("click", () => filterTransaction(transaction.txId));
      return button;
    }));
    $("tx-none").hidden = transactions.length > 0;
    $("tx-more").hidden = transactions.length <= transactionLimit;
    $("tx-shown").textContent = `${Math.min(transactionLimit, transactions.length)} / ${transactions.length}`;
  }
  function render(entry) {
    const tr = node("tr");
    tr.append(node("td", entry.line, "line-number"));
    tr.append(node("td", entry.timestamp || "—", "timestamp"));
    const level = node("td");
    level.append(node("span", entry.level, `badge level-${entry.level.toLowerCase()}`));
    const source = node("td");
    source.append(node("span", entry.source, "source"));
    if (entry.scope) source.append(node("small", entry.scope, "scope"));
    const tx = node("td");
    if (entry.txId) {
      const button = node("button", entry.txId, "tx-link");
      button.title = entry.txId + " - " + "Ver todas las entradas de esta transacción";
      button.addEventListener("click", () => filterTransaction(entry.txId));
      tx.append(button);
    } else { tx.append(node("span", "—", "muted")); }
    const message = node("td", undefined, "message");
    const details = node("details");
    details.open = $("expand").checked;
    const summary = node("summary", entry.message.split("\n")[0]);
    details.append(summary, node("pre", entry.raw));
    message.append(details);
    tr.append(level, source, tx, message);
    return tr;
  }
  async function entries() {
    $("error").hidden = true;
    $("status").textContent = "Leyendo archivo…";
    const query = new URLSearchParams({ file });
    for (const field of ["level", "source", "txId"]) if ($(field).value) query.set(field, $(field).value);
    const address = new URLSearchParams(query);
    if (cursor !== null) query.set("before", cursor);
    window.history.replaceState(null, "", `${location.pathname}?${address}`);
    try {
      const result = await get("/api/entries", query);
      metadata = result;
      nextCursor = result.nextCursor;
      options("level", result.facets.levels);
      options("source", result.facets.sources);
      renderSummary(result);
      $("entries").replaceChildren(...result.entries.map(render));
      $("total").textContent = result.total.toLocaleString();
      $("matched").textContent = result.matched.toLocaleString();
      $("file-size").textContent = bytes(result.file.size);
      $("file-updated").textContent = new Date(result.file.modifiedAt).toLocaleString();
      $("empty").hidden = result.entries.length > 0;
      $("status").textContent = `${result.entries.length} entradas · Más recientes primero`;
      $("older").disabled = nextCursor === null;
      $("newer").disabled = history.length === 0;
      $("page-number").textContent = `Página ${history.length + 1}`;
      $("active-tx").hidden = !$("txId").value;
      $("active-tx-value").textContent = $("txId").value;
    } catch (cause) { error(cause); }
  }
  function restart() {
    clearTimeout(timer);
    cursor = null;
    history.length = 0;
    entries();
  }
  $("refresh").addEventListener("click", () => page === "files" ? files() : restart());
  if (page === "files") { files(); return; }
  if (window.matchMedia("(max-width: 1100px)").matches) $("tx-panel").open = false;
  for (const id of ["tx-search", "tx-errors-only"]) $(id).addEventListener(id === "tx-search" ? "input" : "change", () => {
    transactionLimit = 100;
    renderTransactions();
  });
  $("tx-more").addEventListener("click", () => { transactionLimit += 100; renderTransactions(); });
  $("filename").textContent = file;
  for (const field of ["level", "source", "txId"]) {
    const value = params.get(field) || "";
    if (field !== "txId" && value) $(field).add(new Option(value, value));
    $(field).value = value;
    $(field).addEventListener(field === "txId" ? "input" : "change", () => {
      clearTimeout(timer);
      timer = setTimeout(restart, field === "txId" ? 300 : 0);
    });
  }
  $("filters").addEventListener("submit", event => { event.preventDefault(); clearTimeout(timer); restart(); });
  $("clear").addEventListener("click", () => {
    clearTimeout(timer);
    for (const field of ["level", "source", "txId"]) $(field).value = "";
    restart();
  });
  $("clear-tx").addEventListener("click", () => filterTransaction(""));
  $("copy-tx").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("txId").value);
      $("copy-tx").textContent = "Copiado";
      setTimeout(() => { $("copy-tx").textContent = "Copiar txId"; }, 1500);
    } catch { $("status").textContent = "Selecciona el txId para copiarlo"; }
  });
  $("older").addEventListener("click", () => {
    if (nextCursor === null) return;
    history.push(cursor);
    cursor = nextCursor;
    entries();
  });
  $("newer").addEventListener("click", () => { cursor = history.pop() ?? null; entries(); });
  $("expand").addEventListener("change", event => {
    for (const details of $("entries").querySelectorAll("details")) details.open = event.target.checked;
  });
  $("download").addEventListener("click", () => {
    if (!metadata) return;
    const blob = new Blob([metadata.entries.map(entry => entry.raw).reverse().join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = node("a");
    link.href = url;
    link.download = `filtrado-${file}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  entries();
}

/** Standalone Express router: the host chooses its mount point and authorization. */
function createLogViewer(options = {}) {
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

export { createLogViewer, parseLogLine };
//# sourceMappingURL=api-log-viewer.js.map
