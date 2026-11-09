import { it } from "node:test";
import assert from "node:assert/strict";
import { createApi, getContext } from "../src/server/index.js";
import { parseLogLine } from "../src/log-viewer/parser.js";
import { createTestSeq } from "./helpers/seq.js";

it("correlates concurrent HTTP requests with SQL, model and log-viewer transaction IDs", async () => {
  const logs = [];
  const txIds = { Ana: "11111111-1111-4111-8111-111111111111", Luis: "22222222-2222-4222-8222-222222222222" };
  const seq = createTestSeq({
    getContext,
    logging: { info: false, trace: (...args) => logs.push(args), warn: false, error: false },
    slowQueryMs: Number.MAX_VALUE,
    slowOperationMs: Number.MAX_VALUE,
  });
  const api = await createApi({ seq, basePath: "/api", modules: [{
    name: "personas", modelName: "Persona", tableName: "personas", timestamps: false,
    attributes: { id: { type: "integer", primaryKey: true }, nombre: { type: "string" } },
  }] });
  let server;
  try {
    await seq.authenticate();
    await seq.sync();
    const Persona = seq.getModel("Persona");
    await Persona.create({ id: 1, nombre: "Ana" });
    await Persona.create({ id: 2, nombre: "Luis" });
    logs.length = 0;
    server = await new Promise(resolve => {
      const listener = api.app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api/personas`;
    const responses = await Promise.all(["Ana", "Luis"].map(nombre => fetch(`${base}?nombre=${nombre}`, {
      headers: { "x-transaction-id": txIds[nombre] },
    })));
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    for (const nombre of ["Ana", "Luis"]) {
      const sql = logs.filter(args => args[2]?.type === "sql" && args[2].sql.startsWith("SELECT") && args[2].params.includes(nombre));
      assert.ok(sql.length > 0, `expected SQL for ${nombre}`);
      for (const args of sql) {
        assert.equal(args[0], "[SEQ]");
        assert.equal(args[1], txIds[nombre]);
        assert.equal(args.length, 3);
        assert.ok(Number.isFinite(args[2].sqlDurationMs));
      }
      assert.ok(logs.some(args => args[2]?.type === "model-operation" && args[2].model === "Persona"
        && args[2].operation === "findAll" && args[1] === txIds[nombre]));
    }
    assert.ok(logs.every(args => Object.values(txIds).includes(args[1])));
    for (const [origin, txId, payload] of logs) {
      const line = `[2026-10-21 10:00:00] [TRACE] ${origin} ${txId} ${JSON.stringify(payload)}`;
      const parsed = parseLogLine(line);
      assert.equal(parsed.txId, txId);
      assert.equal(parsed.scope, payload.type);
      assert.equal(parsed.durationMs, payload.sqlDurationMs ?? payload.operationDurationMs);
    }
    logs.length = 0;
    assert.equal((await fetch(base)).status, 200);
    const generated = logs.map(args => args[1]);
    assert.match(generated[0], /^[0-9a-f-]{36}$/i);
    assert.ok(generated.every(txId => txId === generated[0]));
    logs.length = 0;
    await Persona.findAll();
    assert.ok(logs.length > 0);
    assert.ok(logs.every(args => args.length === 2 && args[0] === "[SEQ]" && typeof args[1] === "object"));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await api.close();
  }
});
