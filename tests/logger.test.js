import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, logger, LEVELS } from "logger";
import { log, setLogging } from "../src/server/logger/index.js";

test("logger receives a plain api origin without nested brackets", (t) => {
  const output = [];
  t.mock.method(console, "log", (...args) => output.push(args));
  createLogger({ name: false, displayConsole: true, level: LEVELS.INFO });
  setLogging(logger);
  try {
    log("info", "request", "tx-logging", "GET", "/api/ping", 200);
    assert.equal(output.length, 1);
    assert.deepEqual(output[0].slice(2, 4), ["[api]", "[request]"]);
    assert.deepEqual(output[0].slice(4), ["tx-logging", "GET", "/api/ping", 200]);
  } finally {
    setLogging(false);
  }
});
