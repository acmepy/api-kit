import { it } from "node:test";
import assert from "node:assert/strict";
import { BaseService, createAdapter } from "../src/client/index.js";

it("detail validation uses its own cached rows for uniqueness and accepts the current composite key", async () => {
  const service = new BaseService({ name: "recibos", client: {}, createAdapter,
    details: { detalles: { foreignKey: "reciboId", primaryKeyAttributes: ["reciboId", "numero"], schemas: {
      create: { type: "object", required: ["reciboId", "numero", "referencia"], properties: {
        reciboId: { type: "integer" }, numero: { type: "integer" }, referencia: { type: "string", unique: true },
      } },
    } } },
  });
  await service.adapter.add({ id: 1, referencia: "CABECERA", detalles: [{ reciboId: 1, numero: 1, referencia: "DETALLE" }] });
  await assert.rejects(() => service.validateDetail("detalles", { numero: 2, referencia: "DETALLE" }),
    error => error.errors.referencia === "Ya existe un registro con este valor");
  await assert.rejects(() => service.validateDetailAt("detalles", "referencia", { referencia: "DETALLE" }),
    error => error.errors.referencia === "Ya existe un registro con este valor");
  assert.deepEqual(await service.validateDetail("detalles", { reciboId: 1, numero: 1, referencia: "DETALLE" }),
    { reciboId: 1, numero: 1, referencia: "DETALLE" });
  assert.deepEqual(await service.validateDetail("detalles", { numero: 2, referencia: "CABECERA" }),
    { numero: 2, referencia: "CABECERA" });
  await assert.rejects(() => service.validateDetail("inexistente", {}), /Detalle "inexistente" no disponible/);
});
