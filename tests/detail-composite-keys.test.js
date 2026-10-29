import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createApi } from "../src/server/index.js";
import { createTestSeq } from "./helpers/seq.js";

describe("detail routes with composite primary keys", () => {
  for (const operation of ["create", "create with parent in body", "update", "remove"]) {
    it(`${operation} addresses the article within its price list and preserves leading zeros`, async () => {
      const seq = createTestSeq({ logging: false });
      const api = await createApi({
        seq,
        basePath: "/api",
        modules: [{
          name: "listasPrecios",
          modelName: "ListaPrecio",
          tableName: "REP_LISTA_PRECIO_CAB",
          timestamps: false,
          attributes: {
            codListaPrecio: { type: "string", primaryKey: true },
            descripcion: { type: "string" },
          },
          details: [{
            name: "detalles",
            modelName: "ListaPrecioDetalle",
            tableName: "REP_LISTA_PRECIO_DET",
            foreignKey: "codListaPrecio",
            timestamps: false,
            attributes: {
              codListaPrecio: { type: "string", primaryKey: true, allowNull: false },
              codArticulo: { type: "string", primaryKey: true, allowNull: false },
              precio: { type: "number", allowNull: false },
            },
          }],
        }],
      });
      await seq.authenticate();
      await seq.init();
      await seq.sync({ force: true });
      const parent = api.services.get("listasPrecios").model;
      const detail = parent.getAssociationIncludes().find((association) => association.as === "detalles").model;
      assert.equal(parent.tableName, "REP_LISTA_PRECIO_CAB");
      assert.equal(detail.tableName, "REP_LISTA_PRECIO_DET");
      await parent.create({ codListaPrecio: "001", descripcion: "Primera" });
      await parent.create({ codListaPrecio: "002", descripcion: "Segunda" });
      await detail.create({ codListaPrecio: "002", codArticulo: "A1", precio: 200 });
      const creates = operation.startsWith("create");
      if (!creates) await detail.create({ codListaPrecio: "001", codArticulo: "A1", precio: 100 });
      const server = await new Promise((resolve) => {
        const listener = api.app.listen(0, "127.0.0.1", () => resolve(listener));
      });
      // An OS-assigned port can be on fetch's blocked-port list (especially on Windows).
      const request = (method, path, body) => new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: "127.0.0.1", port: server.address().port, path,
          method, headers: { "Content-Type": "application/json" } }, (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { text += chunk; });
          response.on("error", reject);
          response.on("end", () => {
            try { resolve({ status: response.statusCode, body: JSON.parse(text) }); }
            catch (error) { reject(error); }
          });
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
      try {
        const result = creates
          ? await request("POST", "/api/listasPrecios/001/detalles", { codArticulo: "A1", precio: 150, ...(operation === "create with parent in body" && { codListaPrecio: "002" }) })
          : operation === "update"
            ? await request("PUT", "/api/listasPrecios/001/detalles/A1", { precio: 150 })
            : await request("DELETE", "/api/listasPrecios/001/detalles/A1");
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.data.codListaPrecio, "001");
        assert.equal(result.body.data.codArticulo, "A1");
        assert.equal(result.body.data.id, undefined);
        const other = await detail.findByPk({ codListaPrecio: "002", codArticulo: "A1" }, { plain: true });
        assert.equal(other.precio, 200);
        const current = await detail.findByPk({ codListaPrecio: "001", codArticulo: "A1" }, { plain: true });
        if (operation === "remove") assert.equal(current, null);
        else assert.equal(current.precio, 150);
        if (!creates) {
          const missing = await request(operation === "update" ? "PUT" : "DELETE", "/api/listasPrecios/001/detalles/missing", operation === "update" ? { precio: 500 } : undefined);
          assert.equal(missing.status, 404);
        }
      } finally {
        await api.close();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
});
