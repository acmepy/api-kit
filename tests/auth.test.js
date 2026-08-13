import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createTestSeq } from "./helpers/seq.js";
import { createApiKit } from "../src/server/index.js";

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
    const seq = createTestSeq({ logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      auth: { required: true, secret: "test-secret", tokenExpiresIn: "5m" },
      openapi: { auth: true, permission: "openapi.read" },
      postman: { auth: true, permission: "openapi.read" },
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
      assert.equal(denied.headers["www-authenticate"], 'Basic realm="IAM"');

      const login = await request(server, "POST", "/api/login", {
        body: { username: "admin", password: "1234" },
      });
      assert.equal(login.status, 200);
      assert.equal(login.body.ok, true);
      assert.equal(login.body.data.user.id, "admin");
      assert.equal(typeof login.body.data.token, "string");
      assert.equal(typeof login.body.data.id, "string");
      assert.equal(login.body.data.expiresIn, 300);

      const session = await request(server, "GET", "/api/session", {
        token: login.body.data.token,
      });
      assert.equal(session.status, 200);
      assert.equal(session.body.data.user.id, "admin");

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
      assert.equal(forbidden.body.ok, false);

      const logout = await request(server, "POST", "/api/logout", {
        token: login.body.data.token,
      });
      assert.equal(logout.status, 200);
      assert.deepEqual(logout.body.data, {});

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
      assert.deepEqual(openapi.body.paths["/api/session"].get.security, [{ bearerAuth: [] }, { basicAuth: [] }]);

      const deniedPostman = await request(server, "GET", "/api/postman.json");
      assert.equal(deniedPostman.status, 401);

      const postman = await request(server, "GET", "/api/postman.json", { basic: ["admin", "1234"] });
      assert.equal(postman.status, 200);
      const root = postman.body.item.find((item) => item.name === "api");
      const sessionFolder = root.item.find((item) => item.name === "session");
      assert.deepEqual(sessionFolder.item.map((item) => item.name), ["Login", "Session", "Logout"]);
      const loginRequest = sessionFolder.item.find((item) => item.name === "Login");
      assert.deepEqual(JSON.parse(loginRequest.request.body.raw), { username: "admin", password: "1234" });
      assert.deepEqual(loginRequest.event[0].script.exec, [
        "const response = pm.response.json();",
        "pm.collectionVariables.set(\"bearerToken\", response.data.token);",
        "",
      ]);
      const logoutRequest = sessionFolder.item.find((item) => item.name === "Logout");
      assert.deepEqual(logoutRequest.event[0].script.exec, [
        "pm.collectionVariables.set(\"bearerToken\", null);",
        "",
      ]);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("delegates bearer-only auth challenges to iam", async () => {
    const seq = createTestSeq({ logging: false });
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
      assert.equal(denied.headers["www-authenticate"], 'Basic realm="IAM"');
    } finally {
      await api.close();
      await close(server);
    }
  });
});

async function seedIam(models, permissions) {
  const user = await models.User.create({ id: "admin", password: "1234", name: "Admin", email: "admin@example.com", active: true });
  const role = await models.Role.create({ role: "admin", active: true });
  await models.UserRole.create({ userId: user.get("id"), roleId: role.get("id"), active: true });

  for (const permissionName of permissions) {
    const permission = await models.Permission.create({ permission: permissionName, active: true });
    await models.RolePermission.create({ roleId: role.get("id"), permissionId: permission.get("id"), active: true });
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
