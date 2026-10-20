import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import { createLogViewer, parseLogLine } from "../src/log-viewer/index.js";
import { createLogReader } from "../src/log-viewer/reader.js";

const TX = "5208b08d-c3db-4325-b54a-38f4fe7e9a61";
const OTHER = "9bc1888d-f5e6-485f-9278-44d049eb756b";
const prefix = "[2026-10-20 11:38:52]";
const rows = [
  "Startup without a timestamp",
  `${prefix} [TRACE] [IAM] [auth] ${TX} Acceso autenticado {"userId":"R11"}`,
  `${prefix} [TRACE] [IAM] Permiso concedido {"txId":"${TX}","permission":"sifen.list"}`,
  `${prefix} [ERROR] [api] [http.error] [${TX}] Error <script>alert(1)</script>`,
  "  at readFile (node:fs:1:1)",
  "  at service (service.js:2:2)",
  `${prefix} [INFO] [api] [request] ${TX} ::1 GET /api/sifen 500`,
  `${prefix} [INFO] [api] [request] ${OTHER} ::1 GET /api/ping 200`,
];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-log-viewer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "logs");
  await mkdir(directory);
  await writeFile(path.join(directory, "reparto.log"), rows.join("\r\n"));
  return { root, directory };
}

async function server(t, directory, options = {}) {
  const app = express();
  app.use(helmet());
  app.use("/admin/logs", createLogViewer({ directory, ...options }));
  const listener = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const base = `http://127.0.0.1:${listener.address().port}/admin/logs`;
  return { base, get: async (route) => {
    const response = await fetch(`${base}${route}`);
    return { status: response.status, headers: response.headers, body: await response.json() };
  } };
}

describe("log viewer", () => {
  it("parses bare, bracketed and JSON transaction IDs without guessing absent IDs", () => {
    const parsed = rows.filter(row => row.startsWith("[")).map(parseLogLine);
    assert.deepEqual(parsed.map(entry => entry.txId), [TX, TX, TX, TX, OTHER]);
    assert.equal(parsed[0].source, "IAM");
    assert.equal(parsed[0].scope, "auth");
    assert.equal(parsed[2].scope, "http.error");
    assert.equal(parseLogLine(`${prefix} [INFO] [app] Ready`).txId, null);
    assert.equal(parseLogLine(`${prefix} [INFO] [api] Some unrelated UUID ${TX}`).txId, null);
    assert.equal(parseLogLine(`${prefix} [TRACE] [IAM] Granted {"txId":"custom-123"}`).txId, "custom-123");
    assert.equal(parseLogLine(`\u001b[31m${prefix} [ERROR] [api] Error\u001b[0m`).level, "ERROR");
    assert.equal(parseLogLine("  at service.js:1"), null);
  });

  it("groups stack traces and combines level, source and exact txId filters", async t => {
    const { directory } = await fixture(t);
    const reader = createLogReader({ directory });
    const result = await reader.entries("reparto.log", { txId: TX });
    assert.equal(result.total, 6);
    assert.equal(result.matched, 4);
    assert.equal(result.entries.length, 4);
    assert.deepEqual(result.facets.sources, ["IAM", "Sin origen", "api"]);
    const error = await reader.entries("reparto.log", { txId: TX, level: "error", source: "api" });
    assert.equal(error.matched, 1);
    assert.equal(error.entries[0].line, 4);
    assert.equal(error.entries[0].endLine, 6);
    assert.match(error.entries[0].raw, /at service/);
    assert.equal((await reader.entries("reparto.log", { txId: TX.slice(0, 8) })).matched, 0);
    assert.equal((await reader.entries("reparto.log", { txId: ".*" })).matched, 0);
  });

  it("pages filtered results without duplicates or dropped records and supports empty files", async t => {
    const { directory } = await fixture(t);
    const reader = createLogReader({ directory });
    const first = await reader.entries("reparto.log", { txId: TX, limit: 2 });
    const second = await reader.entries("reparto.log", { txId: TX, limit: 2, before: first.nextCursor });
    assert.deepEqual([...first.entries, ...second.entries].map(entry => entry.line), [7, 4, 3, 2]);
    assert.equal(second.nextCursor, null);
    assert.equal(second.matched, 4);
    await writeFile(path.join(directory, "empty.log"), "");
    assert.deepEqual((await reader.entries("empty.log")).entries, []);
    await writeFile(path.join(directory, "ignore.txt"), "private");
    assert.deepEqual((await reader.files()).map(file => file.name).sort(), ["empty.log", "reparto.log"]);
  });

  it("summarizes the full file and groups transactions independently of filters and pagination", async t => {
    const { directory } = await fixture(t);
    const reader = createLogReader({ directory });
    const full = await reader.entries("reparto.log");
    assert.deepEqual(full.summary, { byLevel: { UNKNOWN: 1, TRACE: 2, ERROR: 1, INFO: 2 }, transactions: 2, withoutTxId: 1 });
    assert.deepEqual(full.transactions.map(({ txId, count, errorCount, firstLine, lastLine }) => ({ txId, count, errorCount, firstLine, lastLine })), [
      { txId: OTHER, count: 1, errorCount: 0, firstLine: 8, lastLine: 8 },
      { txId: TX, count: 4, errorCount: 1, firstLine: 2, lastLine: 7 },
    ]);
    const filtered = await reader.entries("reparto.log", { level: "ERROR", source: "api", txId: TX, before: 8, limit: 1 });
    assert.equal(filtered.matched, 1);
    assert.deepEqual(filtered.summary, full.summary);
    assert.deepEqual(filtered.transactions, full.transactions);
    await writeFile(path.join(directory, "empty.log"), "");
    const empty = await reader.entries("empty.log");
    assert.deepEqual(empty.summary, { byLevel: {}, transactions: 0, withoutTxId: 0 });
    assert.deepEqual(empty.transactions, []);
  });

  it("combines differently cased UUIDs in one transaction and orders by last appearance", async t => {
    const { directory } = await fixture(t);
    await writeFile(path.join(directory, "reparto.log"), [...rows, `${prefix} [INFO] [api] [request] ${TX.toUpperCase()} GET /test 200`].join("\n"));
    const result = await createLogReader({ directory }).entries("reparto.log", { txId: TX });
    assert.equal(result.transactions.length, 2);
    assert.equal(result.transactions[0].txId, TX);
    assert.equal(result.transactions[0].count, 5);
    assert.equal(result.matched, 5);
    assert.equal(result.summary.byLevel.INFO, 3);
  });

  it("accepts a custom line parser", async t => {
    const { directory } = await fixture(t);
    await writeFile(path.join(directory, "custom.log"), "INFO | custom-tx | Ready");
    const reader = createLogReader({ directory, parseLine(line) {
      const match = /^(\w+) \| ([^|]+) \| (.*)$/.exec(line);
      return match ? { timestamp: null, level: match[1], source: "custom", scope: null, txId: match[2], message: match[3] } : null;
    } });
    assert.equal((await reader.entries("custom.log", { txId: "custom-tx" })).matched, 1);
  });

  it("serves pages, assets and filtered JSON under a nested mount with Helmet", async t => {
    const { directory } = await fixture(t);
    const { base, get } = await server(t, directory, { pageSize: 2 });
    for (const route of ["/", "/view?file=reparto.log"]) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /src="\/admin\/logs\/assets\/viewer.js"/);
      assert.match(html, /href="\/admin\/logs\/assets\/viewer.css"/);
      assert.doesNotMatch(html, /<script>/);
    }
    for (const route of ["/assets/viewer.js", "/assets/viewer.css"]) assert.equal((await fetch(`${base}${route}`)).status, 200);
    const files = await get("/api/files");
    assert.equal(files.body.files[0].name, "reparto.log");
    assert.equal(files.headers.get("cache-control"), "no-store");
    const result = await get(`/api/entries?file=reparto.log&txId=${TX}&level=ERROR&source=api`);
    assert.equal(result.status, 200);
    assert.equal(result.body.matched, 1);
    assert.equal(result.body.entries[0].txId, TX);
    assert.equal(result.body.summary.byLevel.INFO, 2);
    assert.equal(result.body.transactions.length, 2);
    const js = await (await fetch(`${base}/assets/viewer.js`)).text();
    assert.doesNotThrow(() => new Function(js));
    assert.doesNotMatch(js, /innerHTML/);
  });

  it("rejects traversal, invalid filters and files outside the directory", async t => {
    const { root, directory } = await fixture(t);
    await writeFile(path.join(root, "outside.log"), "outside");
    // A junction on Windows does not require symlink privileges.
    await symlink(root, path.join(directory, "outside.log"), process.platform === "win32" ? "junction" : "dir");
    const { get } = await server(t, directory);
    for (const file of ["../outside.log", "..\\outside.log", "C:\\outside.log", "reparto.log/other", "other.txt"]) {
      assert.equal((await get(`/api/entries?${new URLSearchParams({ file })}`)).status, 400);
    }
    assert.equal((await get("/api/entries?file=outside.log")).status, 403);
    assert.equal((await get("/api/entries?file=missing.log")).status, 404);
    for (const query of ["limit=0", "limit=501", "limit=2x", "before=0", "before=no", "level=A&level=B"]) {
      assert.equal((await get(`/api/entries?file=reparto.log&${query}`)).status, 400);
    }
    assert.equal((await get("/api/files")).body.files.length, 1);
  });

  it("can be protected by the host middleware, including assets and API routes", async t => {
    const { directory } = await fixture(t);
    const app = express();
    app.use("/logs", (_req, res) => res.sendStatus(403), createLogViewer({ directory }));
    const listener = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    t.after(() => new Promise(resolve => listener.close(resolve)));
    for (const route of ["/", "/view", "/api/files", "/api/entries?file=reparto.log", "/assets/viewer.js"]) {
      assert.equal((await fetch(`http://127.0.0.1:${listener.address().port}/logs${route}`)).status, 403);
    }
  });
});
