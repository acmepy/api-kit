import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { extractTxId, parseLogLine } from "./parser.js";

export class LogFileError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function createLogReader({ directory, parseLine = parseLogLine } = {}) {
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
