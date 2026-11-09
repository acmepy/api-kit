import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, logger, LEVELS } from "logger";
import { log, setLogging } from "../src/server/logger/index.js";
import { runWithContext } from "../src/server/context/request-context.js";
import { parseLogLine } from "../src/log-viewer/parser.js";

test("logger-js receives API, txId and one JSON string without nested brackets", (t) => {
  const output = [];
  t.mock.method(console, "log", (...args) => output.push(args));
  createLogger({ name: false, displayConsole: true, level: LEVELS.INFO });
  setLogging(logger);
  try {
    log("info", "request", { txId: "tx-logging", method: "GET", path: "/api/ping", status: 200 });
    assert.equal(output.length, 1);
    assert.deepEqual(output[0].slice(2, 4), ["[API]", "tx-logging"]);
    assert.equal(output[0].length, 5);
    const data = JSON.parse(output[0][4]);
    assert.deepEqual(data, { type: "request", txId: "tx-logging", method: "GET", path: "/api/ping", status: 200 });
    const parsed = parseLogLine(`[2026-11-09 10:00:00] [INFO] ${output[0].slice(2).join(" ")}`);
    assert.equal(parsed.txId, "tx-logging");
    assert.equal(parsed.source, "API");
    assert.equal(parsed.scope, "request");
  } finally {
    setLogging(false);
  }
});

test("structured logs preserve concurrent contexts and validation error details on one line", async () => {
  const entries = [];
  setLogging({ error: (...args) => entries.push(args) });
  try {
    await Promise.all(["first", "second"].map(txId => new Promise(resolve => {
      runWithContext({ headers: { "x-transaction-id": txId }, protocol: "http", get: () => "localhost", originalUrl: "/api/test" }, {}, async () => {
        await new Promise(done => setImmediate(done));
        const error = Object.assign(new Error('Invalid "currency"\nSecond line'), {
          code: "VALIDATION_ERROR", errors: { RecibosDet: { codMoneda: "Requerido | Formato incorrecto" } }, details: { model: "RecibosDet" },
        });
        log("error", "audit.sse", error);
        resolve();
      });
    })));
    assert.deepEqual(entries.map(entry => entry[1]), ["first", "second"]);
    for (const [origin, txId, serialized] of entries) {
      assert.equal(origin, "[API]");
      assert.equal(serialized.includes("\n"), false);
      const data = JSON.parse(serialized);
      assert.equal(data.txId, txId);
      assert.equal(data.error.message, 'Invalid "currency"\nSecond line');
      assert.equal(data.error.errors.RecibosDet.codMoneda, "Requerido | Formato incorrecto");
      assert.equal(data.error.details.model, "RecibosDet");
      assert.match(data.error.stack, /Error:/);
    }
  } finally { setLogging(false); }
});

test("console and function loggers receive structured payloads without a request context", t => {
  const consoleEntries = [];
  const functionEntries = [];
  t.mock.method(console, "info", (...args) => consoleEntries.push(args));
  try {
    setLogging(true);
    log("info", "startup", { message: "Ready" });
    assert.deepEqual(consoleEntries, [["[API]", '{"type":"startup","message":"Ready"}']]);
    setLogging((...args) => functionEntries.push(args));
    log("info", "custom", "text", 1);
    assert.deepEqual(functionEntries, [["[API]", "info", '{"type":"custom","data":["text",1]}']]);
    setLogging(false);
    log("info", "hidden", {});
    assert.equal(functionEntries.length, 1);
    setLogging({ warn: false });
    assert.doesNotThrow(() => log("warn", "disabled"));
  } finally { setLogging(false); }
});
