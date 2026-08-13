import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BaseService } from "../src/client/services/base-service.js";

describe("Client BaseService", () => {
  it("sends discovered operations through the public request helper", async () => {
    const calls = [];
    const service = new BaseService({
      client: {
        async request(path, options) {
          calls.push({ path, options });
          return { ok: true, data: { ruc: "123" } };
        },
      },
      name: "clientes",
      operations: {
        ruc: { path: "/clientes/ruc/{ruc}", method: "GET" },
      },
      createAdapter: () => memoryAdapter(),
    });

    const result = await service.request("ruc", { params: { ruc: "123" }, query: { exact: true } });

    assert.deepEqual(result, { ok: true, data: { ruc: "123" } });
    assert.deepEqual(calls, [
      {
        path: "/clientes/ruc/123",
        options: { method: "GET", query: { exact: true }, body: undefined },
      },
    ]);
  });

  it("loads service schema through the discovered schema operation", async () => {
    const calls = [];
    const service = new BaseService({
      client: {
        async request(path, options) {
          calls.push({ path, options });
          return { ok: true, data: { create: { type: "object" } } };
        },
      },
      name: "clientes",
      operations: {
        schema: { path: "/clientes/schema", method: "GET" },
      },
      createAdapter: () => memoryAdapter(),
    });

    const result = await service.schema();

    assert.deepEqual(result, { ok: true, data: { create: { type: "object" } } });
    assert.deepEqual(calls, [
      {
        path: "/clientes/schema",
        options: { method: "GET", query: {}, body: undefined },
      },
    ]);
  });

  it("pulls list pages and stores downloaded records locally", async () => {
    const records = [];
    const adapter = memoryAdapter(records);
    const calls = [];
    const service = new BaseService({
      client: {
        async request(path, options) {
          calls.push({ path, options });
          if (options.query.page === 2) return { ok: true, data: [{ id: 2, name: "Beto" }] };
          return { ok: true, data: [{ id: 1, name: "Ana" }], meta: { hasNextPage: true, page: 1 } };
        },
      },
      name: "clientes",
      operations: {
        list: { path: "/clientes", method: "GET" },
      },
      createAdapter: () => adapter,
    });

    const result = await service.pull();

    assert.deepEqual(result, {
      ok: true,
      data: [
        { id: 1, name: "Ana" },
        { id: 2, name: "Beto" },
      ],
    });
    assert.deepEqual(records, [
      { id: 1, name: "Ana" },
      { id: 2, name: "Beto" },
    ]);
    assert.deepEqual(calls.map((call) => call.options.query), [{}, { page: 2 }]);
  });

  it("stores and sends delete operations as pending when requested", async () => {
    const records = [{ id: 1, name: "Ana" }];
    const calls = [];
    const service = new BaseService({
      client: {
        async request(path, options) {
          calls.push({ path, options });
          return { ok: true, data: { id: 1 } };
        },
      },
      name: "clientes",
      operations: {
        remove: { path: "/clientes/{id}", method: "DELETE" },
      },
      createAdapter: () => memoryAdapter(records),
    });

    const result = await service.remove(1, { pending: true });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      {
        path: "/clientes/1",
        options: { method: "DELETE", query: {}, body: undefined },
      },
    ]);
    assert.deepEqual(records, [{ id: 1, name: "Ana", pending: true, operation: "remove", status: "pending", message: "", errors: null }]);
  });

  it("sends delete requests when removing while connected", async () => {
    const records = [{ id: 1, name: "Ana" }];
    const calls = [];
    const service = new BaseService({
      client: {
        connected() {
          return true;
        },
        async request(path, options) {
          calls.push({ path, options });
          return { ok: true, data: { id: 1 } };
        },
      },
      name: "clientes",
      operations: {
        remove: { path: "/clientes/{id}", method: "DELETE" },
      },
      createAdapter: () => memoryAdapter(records),
    });

    const result = await service.remove(1);

    assert.deepEqual(result, { ok: true, data: { id: 1 } });
    assert.deepEqual(calls, [
      {
        path: "/clientes/1",
        options: { method: "DELETE", query: {}, body: undefined },
      },
    ]);
    assert.deepEqual(records, []);
  });

  it("sends update requests directly when pending is false", async () => {
    const records = [{ id: 1, name: "Ana" }];
    const calls = [];
    const service = new BaseService({
      client: {
        async request(path, options) {
          calls.push({ path, options });
          return { ok: true, data: { id: 1, name: "Ana editada" } };
        },
      },
      name: "clientes",
      operations: {
        update: { path: "/clientes/{id}", method: "PUT" },
      },
      createAdapter: () => memoryAdapter(records),
    });

    const result = await service.update("1", { name: "Ana editada" }, { pending: false });

    assert.deepEqual(result, { ok: true, data: { id: 1, name: "Ana editada" } });
    assert.deepEqual(calls, [
      {
        path: "/clientes/1",
        options: { method: "PUT", query: {}, body: { name: "Ana editada" } },
      },
    ]);
    assert.deepEqual(records, [{ id: 1, name: "Ana editada" }]);
  });

  it("removes temporary create records after pending create is sent", async () => {
    const records = [];
    const calls = [];
    const service = new BaseService({
      client: {
        async request(path, options) {
          calls.push({ path, options });
          return { ok: true, data: { id: 10, name: "Ana" } };
        },
      },
      name: "clientes",
      operations: {
        create: { path: "/clientes", method: "POST" },
      },
      createAdapter: () => memoryAdapter(records),
    });

    const result = await service.create({ name: "Ana" }, { pending: true });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      {
        path: "/clientes",
        options: { method: "POST", query: {}, body: { id: 1, name: "Ana" } },
      },
    ]);
    assert.deepEqual(records, []);
  });

  it("propagates validation errors from pending sends", async () => {
    const records = [];
    const service = new BaseService({
      client: {
        async request() {
          const error = new Error("Validacion");
          error.errors = { ruc: "RUC no cumple con el formato esperado" };
          throw error;
        },
      },
      name: "clientes",
      operations: {
        create: { path: "/clientes", method: "POST" },
      },
      createAdapter: () => memoryAdapter(records),
    });

    await assert.rejects(
      () => service.create({ ruc: "bad", name: "Ana" }, { pending: true }),
      (error) => {
        assert.deepEqual(error.errors, { ruc: "RUC no cumple con el formato esperado" });
        return true;
      },
    );
    assert.deepEqual(records[0].errors, { ruc: "RUC no cumple con el formato esperado" });
  });

  it("validates records with yep json schemas", async () => {
    const service = new BaseService({
      client: schemaClient("clientes", {
        create: {
          type: "object",
          required: ["nombre"],
          properties: {
            nombre: { type: "string" },
            ruc: { type: "string", pattern: "^[0-9]+$" },
          },
        },
      }),
      name: "clientes",
      createAdapter: () => memoryAdapter(),
    });

    assert.deepEqual(await service.validate({ nombre: "Ana", ruc: "123" }, "create"), { nombre: "Ana", ruc: "123" });
    await assert.rejects(
      () => service.validate({ ruc: "abc" }, "create"),
      (error) => {
        assert.equal(error.errors.nombre, "Nombre es requerido");
        assert.equal(error.errors.ruc, "Ruc no cumple con el formato esperado");
        return true;
      },
    );
  });

  it("validates one field with validateAt", async () => {
    const service = new BaseService({
      client: schemaClient("clientes", {
        update: {
          type: "object",
          properties: {
            ruc: { type: "string", pattern: "^[0-9]+$" },
          },
        },
      }),
      name: "clientes",
      createAdapter: () => memoryAdapter(),
    });

    assert.equal(await service.validateAt("ruc", { ruc: "123" }, "update"), "123");
    await assert.rejects(
      () => service.validateAt("ruc", { ruc: "abc" }, "update"),
      (error) => {
        assert.deepEqual(error.errors, { ruc: "Ruc no cumple con el formato esperado" });
        return true;
      },
    );
  });

  it("loads validation schemas from the schema service cache", async () => {
    const service = new BaseService({
      client: schemaClient("clientes", {
      create: {
        type: "object",
        required: ["nombre"],
        properties: { nombre: { type: "string" } },
      },
      }),
      name: "clientes",
      createAdapter: () => memoryAdapter(),
    });

    await assert.rejects(
      () => service.validate({}, "create"),
      (error) => {
        assert.deepEqual(error.errors, { nombre: "Nombre es requerido" });
        return true;
      },
    );
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

function schemaClient(serviceName, schemas) {
  return {
    service(name) {
      if (name !== "schema") throw new Error("missing service");
      return {
        async get(id) {
          return { ok: id === serviceName, data: id === serviceName ? { id, ...schemas } : null };
        },
      };
    },
  };
}
