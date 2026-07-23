import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { Seq, SQLiteAdapter } from "seq";
import { createApiKit } from "../src/index.js";

const modules = [
  {
    modelName: "Cliente",
    tableName: "clientes",
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      nombre: { type: "string", allowNull: false },
      activo: { type: "boolean", defaultValue: true },
    },
  },
];

describe("auth", () => {
  it("logs in, authorizes bearer/basic requests, checks permissions, and logs out", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      auth: { required: true, secret: "test-secret", tokenExpiresIn: "5m" },
      openapi: { auth: true, permission: "openapi.read" },
      modules,
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });
    await seedIam(api.auth.models, ["clientes.list", "clientes.create", "openapi.read"]);

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const denied = await request(server, "GET", "/api/clientes");
      assert.equal(denied.status, 401);
      assert.equal(denied.body.ok, false);
      assert.equal(denied.headers["www-authenticate"], 'Basic realm="api-kit", charset="UTF-8"');

      const login = await request(server, "POST", "/api/login", {
        body: { username: "admin", password: "1234" },
      });
      assert.equal(login.status, 200);
      assert.equal(login.body.ok, true);
      assert.equal(login.body.data.user.id, "admin");
      assert.equal(typeof login.body.data.token, "string");
      assert.ok(login.body.data.session.expiresAt);

      const created = await request(server, "POST", "/api/clientes", {
        token: login.body.data.token,
        body: { nombre: "Ana" },
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.data.nombre, "Ana");

      const listed = await request(server, "GET", "/api/clientes", {
        basic: ["admin", "1234"],
      });
      assert.equal(listed.status, 200);
      assert.equal(listed.body.data.length, 1);

      const forbidden = await request(server, "PUT", `/api/clientes/${created.body.data.id}`, {
        token: login.body.data.token,
        body: { activo: false },
      });
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.body.code, "FORBIDDEN");

      const logout = await request(server, "POST", "/api/logout", {
        token: login.body.data.token,
      });
      assert.equal(logout.status, 200);
      assert.equal(logout.body.data, true);

      const afterLogout = await request(server, "GET", "/api/clientes", {
        token: login.body.data.token,
      });
      assert.equal(afterLogout.status, 401);

      const deniedOpenapi = await request(server, "GET", "/api/openapi.json");
      assert.equal(deniedOpenapi.status, 401);

      const openapi = await request(server, "GET", "/api/openapi.json", { basic: ["admin", "1234"] });
      assert.equal(openapi.status, 200);
      assert.equal(openapi.body.components.securitySchemes.bearerAuth.scheme, "bearer");
      assert.equal(openapi.body.components.securitySchemes.basicAuth.scheme, "basic");
      assert.deepEqual(openapi.body.paths["/api/clientes"].get.security, [{ bearerAuth: [] }, { basicAuth: [] }]);
      assert.deepEqual(openapi.body.paths["/api/clientes"].get["x-permissions"], ["clientes.list"]);
      assert.deepEqual(openapi.body.paths["/api/openapi.json"].get.security, [{ bearerAuth: [] }, { basicAuth: [] }]);
      assert.deepEqual(openapi.body.paths["/api/openapi.json"].get["x-permissions"], ["openapi.read"]);
      assert.equal(openapi.body.paths["/api/login"].post.security, undefined);
      assert.equal(openapi.body.paths["/api/login"].post.requestBody.content["application/json"].schema.properties.password.format, "password");
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("does not send basic auth challenge for bearer-only routes", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      auth: { required: true, strategies: ["bearer"], secret: "test-secret" },
      modules,
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const denied = await request(server, "GET", "/api/clientes");

      assert.equal(denied.status, 401);
      assert.equal(denied.headers["www-authenticate"], undefined);
    } finally {
      await api.close();
      await close(server);
    }
  });
});

async function seedIam(models, permissions) {
  const user = await models.User.create({ id: "admin", password: "1234", name: "Admin", email: "admin@example.com", active: true });
  const role = await models.Role.create({ role: "admin", active: true });
  await models.UserRole.create({ userId: user.getDataValue("id"), roleId: role.getDataValue("id"), active: true });

  for (const permissionName of permissions) {
    const permission = await models.Permission.create({ permission: permissionName, active: true });
    await models.RolePermission.create({ roleId: role.getDataValue("id"), permissionId: permission.getDataValue("id"), active: true });
  }
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(server, method, path, options = {}) {
  const { port } = server.address();
  const headers = { Accept: "application/json" };
  let body = null;

  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.basic) headers.Authorization = `Basic ${Buffer.from(options.basic.join(":")).toString("base64")}`;
  if (options.body) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "localhost", port, path, method, headers }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
