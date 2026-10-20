import express from 'express';
import { open, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

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

function renderPage(base, page) {
  const root = escape(base);
  const viewer = page === "view";
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${viewer ? "Archivo de log" : "Logs disponibles"} · Log Explorer</title>
<link rel="stylesheet" href="${root}/assets/viewer.css"><script src="${root}/assets/viewer.js" defer></script></head>
<body data-base="${root}" data-page="${page}">
<header><a class="brand" href="${root}/"><span class="brand-icon">&#8801;</span> Log Explorer</a><span class="header-note">DIAGNÓSTICO / REGISTROS</span></header>
<main>
<nav class="breadcrumb"><a href="${root}/">Archivos de log</a>${viewer ? '<span>/</span><span>Explorar archivo</span>' : ""}</nav>
<div class="heading"><div><p class="eyebrow">OBSERVABILIDAD</p><h1>${viewer ? '<span id="filename">Archivo de log</span>' : 'Cada evento, en contexto.'}</h1><p class="description">${viewer ? 'Filtra el ruido. Sigue una transacción de principio a fin.' : 'Selecciona un archivo para explorar sus eventos y seguir una transacción.'}</p></div><button id="refresh" class="button">&#8635; Actualizar</button></div>
<p id="error" class="error" role="alert" hidden></p>
${viewer ? `
<section class="stats" aria-label="Resumen del archivo"><div><span>ENTRADAS</span><strong id="total">—</strong></div><div><span>COINCIDENCIAS</span><strong id="matched">—</strong></div><div><span>TAMAÑO</span><strong id="file-size">—</strong></div><div><span>ÚLTIMA MODIFICACIÓN</span><strong id="file-updated" class="date-value">—</strong></div></section>
<div class="summary-heading"><span>RESUMEN DEL ARCHIVO</span><span>Totales de todas las entradas</span></div><section id="level-summary" class="level-summary" aria-label="Cantidad de entradas por nivel"></section>
<div class="explorer-layout"><aside class="tx-sidebar" aria-label="Transacciones del archivo"><details id="tx-panel" open><summary>Transacciones <span id="tx-total" class="count">0</span></summary><div class="tx-tools"><label class="sr-only" for="tx-search">Buscar transacciones</label><input id="tx-search" type="search" placeholder="Buscar txId..." autocomplete="off" spellcheck="false"><label class="tx-errors-filter"><input id="tx-errors-only" type="checkbox"> Solo con errores</label></div><nav id="tx-list" class="tx-list" aria-label="Seleccionar transaccion"></nav><p id="tx-none" class="tx-empty" hidden>Sin transacciones coincidentes</p><button type="button" id="tx-more" class="tx-more" hidden>Mostrar 100 m&aacute;s</button><div class="tx-footer"><span id="tx-shown">0 / 0</span><span id="tx-unassigned"></span></div></details></aside><div class="explorer-main">
<form id="filters" class="filters"><label>Nivel<select id="level"><option value="">Todos los niveles</option></select></label><label>Origen<select id="source"><option value="">Todos los orígenes</option></select></label><label class="tx-filter">Transacción · txId<input id="txId" type="search" autocomplete="off" spellcheck="false" placeholder="Pega el txId completo para seguir su recorrido"></label><button type="button" id="clear" class="button subtle">Limpiar filtros</button><button type="submit" class="sr-only">Filtrar</button></form>
<div id="active-tx" class="active-tx" hidden><span>TRANSACCIÓN</span><code id="active-tx-value"></code><button id="copy-tx" type="button">Copiar txId</button><button id="clear-tx" type="button" aria-label="Quitar filtro de transacción">×</button></div>
<section class="results"><div class="results-toolbar"><span id="status" role="status">Preparando visor…</span><div><label class="expand"><input id="expand" type="checkbox"> Expandir detalles</label><button id="download" class="text-button">Exportar p&aacute;gina &#8595;</button></div></div><div class="table-wrap"><table><thead><tr><th>LÍNEA</th><th>FECHA / HORA</th><th>NIVEL</th><th>ORIGEN</th><th>TXID</th><th>MENSAJE</th></tr></thead><tbody id="entries"></tbody></table></div><div id="empty" class="empty" hidden><strong>Sin coincidencias</strong><p>Prueba con otro nivel, origen o identificador de transacción.</p></div><div class="pagination"><span id="page-number">Página 1</span><div><button id="newer" class="button" disabled>&#8592; M&aacute;s recientes</button><button id="older" class="button" disabled>M&aacute;s antiguas &#8594;</button></div></div></section></div></div>
` : `
<div class="section-label"><span>ARCHIVOS DISPONIBLES <span id="file-count" class="count">—</span></span><span id="status" role="status">Buscando archivos…</span></div><section id="files" class="file-list" aria-label="Archivos disponibles"></section><div id="empty" class="empty" hidden><strong>Todavía no hay archivos de log</strong><p>Los archivos .log del directorio configurado aparecerán aquí.</p></div>
`}
<footer><span>Log Explorer</span><span>${viewer ? 'Haz clic en un txId para filtrar la transacción completa.' : 'Archivos ordenados por su última modificación.'}</span></footer>
</main></body></html>`;
}

const stylesheet = `
:root{color-scheme:dark;--bg:#101419;--panel:#171d24;--line:#29313b;--text:#e2e9f0;--muted:#8e9aa9;--accent:#84e2bd;font-family:Inter,Segoe UI,system-ui,sans-serif;font-size:14px}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}[hidden]{display:none!important}a{color:inherit;text-decoration:none}button,input,select{font:inherit}button,a,summary{ -webkit-tap-highlight-color:transparent}button{cursor:pointer}button:disabled{opacity:.35;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}header{height:72px;padding:0 4%;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;background:#131920}.brand{font-size:18px;font-weight:650;letter-spacing:-.4px;display:flex;align-items:center;gap:12px}.brand-icon{background:#20392f;color:var(--accent);border:1px solid #385d4c;border-radius:8px;width:32px;height:32px;text-align:center;line-height:27px;font-size:27px}.header-note{color:var(--muted);font-size:10px;letter-spacing:2px}main{padding:26px 4% 0;max-width:1800px;margin:auto}.breadcrumb{display:flex;gap:13px;color:var(--muted);font-size:12px;margin-bottom:38px}.breadcrumb a:hover{color:var(--accent)}.heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:32px}.eyebrow{color:var(--accent);font-size:10px;letter-spacing:2.5px;font-weight:650;margin:0 0 12px}h1{font-size:30px;font-weight:550;letter-spacing:-1px;margin:0;overflow-wrap:anywhere}.description{color:var(--muted);margin:12px 0 0;font-size:13px}.button{border:1px solid #3b4652;background:#202832;border-radius:6px;padding:9px 14px;color:var(--text);white-space:nowrap}.button:hover:not(:disabled){border-color:var(--accent);background:#25352e}.subtle{background:transparent;color:var(--muted)}.stats{display:grid;grid-template-columns:1fr 1fr 1fr 1.6fr;border:1px solid var(--line);border-radius:8px;background:var(--panel);margin-bottom:24px}.stats>div{padding:18px 24px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:10px}.stats>div:last-child{border:0}.stats span{color:var(--muted);font-size:10px;letter-spacing:1.5px}.stats strong{font-weight:500;font-size:25px;font-variant-numeric:tabular-nums}.stats .date-value{font-size:16px;line-height:30px}.filters{display:flex;align-items:end;gap:16px;margin-bottom:22px}.filters label{display:flex;flex-direction:column;gap:8px;color:#b4bfcb;font-size:12px;min-width:150px}.filters select,.filters input{border:1px solid #35404d;border-radius:6px;background:var(--panel);color:var(--text);padding:10px 12px;width:100%;height:40px}.filters input{font-family:Consolas,monospace;font-size:12px}.filters .tx-filter{flex:1}.filters .button{height:40px}.active-tx{display:flex;align-items:center;gap:15px;margin-bottom:20px;background:#172c25;border:1px solid #2c5d49;padding:12px 16px;border-radius:6px;color:var(--accent)}.active-tx>span{font-size:10px;letter-spacing:1.3px}.active-tx code{font-size:12px;overflow-wrap:anywhere}.active-tx button{background:none;border:0;color:var(--accent);font-size:12px}.active-tx button:nth-last-child(2){margin-left:auto}.results{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel)}.results-toolbar{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:15px 18px;border-bottom:1px solid var(--line);color:var(--muted);font-size:12px}.results-toolbar>div{display:flex;gap:24px;align-items:center}.expand{display:flex;align-items:center;gap:8px}.expand input{accent-color:var(--accent)}.text-button{border:0;background:none;color:var(--text);font-size:12px;padding:0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}thead{background:#1d252e}th{font-size:9px;letter-spacing:1.4px;color:var(--muted);font-weight:600;padding:14px 12px;white-space:nowrap}td{padding:13px 12px;border-bottom:1px solid #252d37;vertical-align:top}tbody tr:hover{background:#1d2630}.line-number{font-family:Consolas,monospace;color:#667485;font-size:11px;text-align:right}.timestamp{white-space:nowrap;color:#a5b3c1;font-variant-numeric:tabular-nums;font-family:Consolas,monospace;font-size:11px}.badge{display:inline-block;border:1px solid #3d4e62;background:#243447;color:#b0c9eb;border-radius:4px;padding:3px 7px;font-size:9px;letter-spacing:.5px;min-width:49px;text-align:center}.level-info{color:#91d9bc;background:#1c342c;border-color:#2a5544}.level-trace,.level-debug{color:#a9b7c8;background:#26303d;border-color:#374453}.level-warn,.level-warning{color:#ebc47e;background:#392f1e;border-color:#5f4d2c}.level-error,.level-fatal{color:#f2a4a8;background:#3c252b;border-color:#67343c}.source{font-weight:600;font-size:11px;white-space:nowrap}.scope{display:block;color:var(--muted);font-family:Consolas,monospace;margin-top:5px;font-size:10px}.tx-link{font-family:Consolas,monospace;font-size:10px;color:var(--accent);border:0;background:none;padding:0;max-width:none;white-space:nowrap;display:block;text-align:left}.tx-link:hover{text-decoration:underline}.muted{color:#5d6b7b}.message{min-width:300px;max-width:700px;font-family:Consolas,monospace;color:#c6d1dc;line-height:1.65}.message summary{cursor:pointer;white-space:pre-wrap;overflow-wrap:anywhere}.message pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#10151c;padding:14px;border-radius:4px;font-size:11px;color:#bac8d6;max-height:450px;overflow:auto}.pagination{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 18px;font-size:12px;color:var(--muted)}.pagination>div{display:flex;gap:10px}.section-label{display:flex;justify-content:space-between;gap:12px;font-size:10px;letter-spacing:1.5px;color:var(--muted);margin-bottom:15px}.section-label>#status{letter-spacing:0}.count{display:inline-block;margin-left:8px;padding:3px 7px;background:#28323e;border-radius:4px;color:var(--text)}.file-list{display:flex;flex-direction:column;gap:12px}.file-card{display:flex;align-items:center;gap:22px;padding:24px;border:1px solid var(--line);border-radius:8px;background:var(--panel);transition:border-color .15s}.file-card:hover{border-color:#4f9b7d;background:#1b2828}.file-icon{font-family:Consolas,monospace;font-size:25px;color:var(--accent);padding:12px 16px;background:#21362e;border-radius:6px}.file-card h2{font-size:15px;font-weight:550;margin:0 0 8px;overflow-wrap:anywhere}.file-card p{font-size:12px;color:var(--muted);margin:0}.file-open{margin-left:auto;color:var(--accent);font-size:12px;white-space:nowrap}.empty{padding:55px 20px;text-align:center;color:var(--muted)}.empty strong{color:var(--text);font-weight:500;font-size:17px}.empty p{font-size:13px}.error{color:#ffc0c4;background:#3a2229;border:1px solid #703b44;padding:14px;border-radius:6px}footer{display:flex;justify-content:space-between;gap:20px;color:#6e7b8c;font-size:11px;margin:28px 0;padding:18px 0;border-top:1px solid var(--line)}footer>span:first-child{color:#94a2b2}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(min-width:1600px){.tx-link{max-width:255px}}@media(max-width:760px){header{padding:0 20px;height:60px}.header-note{display:none}main{padding:20px}.breadcrumb{margin-bottom:25px}.heading{align-items:start}h1{font-size:23px}.stats{grid-template-columns:1fr 1fr}.stats>div{padding:15px;border-bottom:1px solid var(--line)}.stats>div:nth-child(2){border-right:0}.stats>div:nth-child(3),.stats>div:nth-child(4){border-bottom:0}.filters{flex-wrap:wrap;gap:12px}.filters label{min-width:0;flex:1}.filters .tx-filter{flex-basis:100%}.filters .button{width:100%}.results-toolbar{align-items:start;flex-direction:column}.results-toolbar>div{justify-content:space-between;width:100%}.active-tx{flex-wrap:wrap;gap:10px}.active-tx code{flex-basis:100%;order:1}.file-card{padding:17px;gap:13px}.file-open{font-size:0}.file-open:after{content:"?";font-size:18px}.file-icon{padding:9px}.section-label{letter-spacing:.5px}.pagination{flex-wrap:wrap}.pagination>div{width:100%;justify-content:space-between}footer{flex-direction:column;gap:8px}}
.summary-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--muted);font-size:10px;letter-spacing:1.4px;margin:4px 0 12px}.summary-heading>span:last-child{letter-spacing:0;font-size:11px}.level-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;margin-bottom:28px}.level-card{display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid var(--line);border-radius:7px;background:var(--panel);padding:16px 18px;color:var(--text)}.level-card span{font-size:10px;letter-spacing:1px;color:var(--muted)}.level-card strong{font-size:24px;font-weight:500;font-variant-numeric:tabular-nums}.level-card:hover,.level-card[aria-pressed="true"]{border-color:var(--accent);background:#1b2d27}.level-card-error strong,.level-card-fatal strong{color:#f2a4a8}.level-card-info strong{color:var(--accent)}.level-card-trace strong{color:#b4c2dd}.level-card-warn strong,.level-card-warning strong{color:#ebc47e}.explorer-layout{display:grid;grid-template-columns:270px minmax(0,1fr);gap:22px;align-items:start}.explorer-main{min-width:0}.tx-sidebar{position:sticky;top:20px;border:1px solid var(--line);border-radius:8px;background:var(--panel);overflow:hidden}.tx-sidebar summary{padding:17px 16px;cursor:pointer;font-weight:550;font-size:13px;list-style-position:inside}.tx-sidebar summary .count{font-weight:400;font-size:10px}.tx-tools{padding:2px 14px 14px;border-bottom:1px solid var(--line)}.tx-tools>input{width:100%;border:1px solid #35404d;background:#10161d;color:var(--text);border-radius:5px;padding:9px 10px;font:11px Consolas,monospace}.tx-errors-filter{display:flex;align-items:center;gap:7px;margin-top:12px;font-size:11px;color:var(--muted)}.tx-errors-filter input{accent-color:var(--accent)}.tx-list{max-height:calc(100vh - 255px);min-height:70px;overflow:auto;padding:7px}.transaction{display:flex;flex-direction:column;gap:8px;text-align:left;width:100%;border:1px solid transparent;border-radius:5px;background:none;color:var(--text);padding:11px 9px;margin:0 0 3px}.transaction:hover{background:#202d34}.transaction[aria-pressed="true"]{background:#1a352a;border-color:#3e795e}.transaction code{font:11px/1.6 Consolas,monospace;overflow-wrap:anywhere;color:#bed2c9}.transaction-meta{display:flex;justify-content:space-between;gap:5px;font-size:10px;color:var(--muted)}.transaction-errors{color:#f2a4a8}.transaction small{font:10px Consolas,monospace;color:#758597}.tx-footer{display:flex;flex-direction:column;gap:7px;border-top:1px solid var(--line);padding:12px 15px;font-size:10px;color:var(--muted)}.tx-more{display:block;width:calc(100% - 28px);margin:5px 14px 12px;padding:8px;border:1px solid #35404d;border-radius:4px;background:#202832;color:var(--text);font-size:11px}.tx-empty{padding:14px;color:var(--muted);font-size:11px}.explorer-main .filters{gap:10px}.explorer-main .filters label{min-width:125px}.explorer-main .filters input{min-width:0}.explorer-main .tx-link{max-width:none}@media(max-width:1100px){.explorer-layout{grid-template-columns:minmax(0,1fr);gap:20px}.tx-sidebar{position:static}.tx-list{max-height:260px}.tx-sidebar summary{padding:14px 16px}}@media(max-width:760px){.summary-heading>span:last-child{display:none}.level-summary{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.level-card{padding:12px 10px;flex-direction:column;align-items:start;gap:8px}.level-card strong{font-size:23px}.explorer-main .filters label{min-width:0}}

`;

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
        const link = node("a", undefined, "file-card");
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
      const button = node("button", undefined, `level-card level-card-${level.toLowerCase()}`);
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
      const button = node("button", undefined, "transaction");
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
