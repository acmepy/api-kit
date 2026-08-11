import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BaseService } from "../src/client/services/base-service.js";

describe("Client BaseService", () => {
  it("pushes pending records and stores message and errors when a request fails", async () => {
    const records = [
      { id: 1, name: "Ana", pending: true, operation: "update", status: "pending", message: "", errors: null },
      { id: 2, name: "Beto", pending: true, operation: "create", status: "pending", message: "", errors: null },
    ];
    const adapter = memoryAdapter(records);
    const calls = [];
    const client = {
      adapter,
      async request(path, options) {
        calls.push({ path, ...options });
        if (options.body.name === "Beto") {
          const error = new Error("Nombre invalido");
          error.errors = { name: "Muy corto" };
          throw error;
        }
        return { ok: true, data: { id: options.body.id, name: "Ana Server" } };
      },
    };
    const service = new BaseService({
      client,
      name: "clientes",
      operations: {
        create: { path: "/clientes", method: "POST" },
        update: { path: "/clientes/{id}", method: "PUT" },
      },
      createAdapter: () => adapter,
    });

    const one = await service.push(1);
    const all = await service.push();

    assert.equal(one.ok, true);
    assert.equal(all.ok, false);
    assert.deepEqual(records[1], {
      id: 2,
      name: "Beto",
      pending: true,
      operation: "create",
      status: "error",
      message: "Nombre invalido",
      errors: { name: "Muy corto" },
    });
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ["PUT /clientes/1", "PUT /clientes/1", "POST /clientes"]);
  });
});

function memoryAdapter(records = []) {
  return {
    async getAll() {
      return records;
    },
    async get(id) {
      return records.find((record) => String(record.id) === String(id)) || null;
    },
    async add(value) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) await this.put(item.id, item);
      return value;
    },
    async put(id, value) {
      const index = records.findIndex((record) => String(record.id) === String(id));
      if (index >= 0) records[index] = value;
      else records.push(value);
      return value;
    },
    async delete(id) {
      const index = records.findIndex((record) => String(record.id) === String(id));
      if (index >= 0) records.splice(index, 1);
    },
    async clear() {
      records.splice(0);
    },
  };
}
