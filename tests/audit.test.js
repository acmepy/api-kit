import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { Seq, SQLiteAdapter } from "seq";
import { createApiKit } from "../src/server/index.js";

const modules = [
  {
    modelName: "Cliente",
    tableName: "clientes",
    timestamps: true,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      nombre: { type: "string", allowNull: false },
      activo: { type: "boolean", defaultValue: true },
    },
  },
  {
    modelName: "Producto",
    tableName: "productos",
    timestamps: true,
    audit: false,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      descripcion: { type: "string", allowNull: false },
    },
  },
  {
    modelName: "audit",
    tableName: "audit",
    timestamps: true,
    audit: false,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      txId: { type: "string", maxLength: 50, allowNull: false },
      clientIp: { type: "string", maxLength: 50, allowNull: false },
      userId: { type: "string", maxLength: 20 },
      tableName: { type: "string", maxLength: 50, allowNull: false },
      rowId: { type: "string", maxLength: 50, allowNull: false },
      action: { type: "string", maxLength: 20, allowNull: false },
      old: { type: "json" },
      new: { type: "json" },
    },
  },
];

describe("audit", () => {
  it("audits enabled modules and skips disabled/audit modules", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({ seq, audit: true, modules });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const cliente = await api.services.get("clientes").create({ body: { nombre: "Ana" } });
    await api.services.get("clientes").update({ params: { id: cliente.data.id }, body: { activo: false } });
    await api.services.get("productos").create({ body: { descripcion: "Mouse" } });

    const Audit = api.models.get("audit");
    const rows = await Audit.findAll({ order: [["id", "ASC"]] });

    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.getDataValue("action")), ["create", "update"]);
    assert.deepEqual(rows.map((row) => row.getDataValue("tableName")), ["clientes", "clientes"]);
    assert.equal(rows[0].getDataValue("new").nombre, "Ana");
    assert.equal(rows[1].getDataValue("old").activo, true);
    assert.equal(rows[1].getDataValue("new").activo, false);
  });

  it("exposes audit changes since a date", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({ seq, basePath: "/api", audit: true, modules });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const since = new Date(Date.now() - 1000).toISOString();
      await api.services.get("clientes").create({ body: { nombre: "Ana" } });

      const res = await request(server, "GET", `/api/changes?since=${encodeURIComponent(since)}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].action, "create");
      assert.equal(res.body.data[0].tableName, "clientes");
      assert.equal(res.body.data[0].new.nombre, "Ana");

      const invalid = await request(server, "GET", "/api/changes");
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.errors.since, "Requerido");
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("filters audit changes by the user's list permission on the changed resource", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      audit: true,
      auth: { required: true, secret: "test-secret" },
      modules,
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });
    await seedAuditAuth(api.auth.models, { viewer: ["audit.changes", "clientes.list"], writer: ["audit.changes", "clientes.create"] });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const since = new Date(Date.now() - 1000).toISOString();
      const cliente = await api.services.get("clientes").create({ body: { nombre: "Ana" } });
      await api.services.get("clientes").remove({ params: { id: cliente.data.id } });

      const viewer = await request(server, "GET", `/api/changes?since=${encodeURIComponent(since)}`, { basic: ["viewer", "1234"] });
      assert.equal(viewer.status, 200);
      assert.deepEqual(viewer.body.data.map((change) => change.action), ["create", "delete"]);

      const writer = await request(server, "GET", `/api/changes?since=${encodeURIComponent(since)}`, { basic: ["writer", "1234"] });
      assert.equal(writer.status, 200);
      assert.deepEqual(writer.body.data, []);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("audits IAM session changes without exposing them through changes or sse events", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      audit: true,
      auth: { required: true, secret: "test-secret" },
      modules,
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });
    await seedAuditAuth(api.auth.models, { admin: ["audit.changes"] });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);
    const emitted = [];
    api.events.on("change", (change) => emitted.push(change));

    try {
      const since = new Date(Date.now() - 1000).toISOString();
      const login = await request(server, "POST", "/api/login", {
        body: { username: "admin", password: "1234" },
      });
      assert.equal(login.status, 200);

      const logout = await request(server, "POST", "/api/logout", {
        token: login.body.data.token,
      });
      assert.equal(logout.status, 200);

      await new Promise((resolve) => setImmediate(resolve));

      const Audit = api.models.get("audit");
      const sessionTableName = tableNameForModel(api.auth.models.Session);
      const rows = await Audit.findAll({ order: [["id", "ASC"]] });
      const sessionRows = rows.map((row) => row.toJSON()).filter((row) => row.tableName === sessionTableName);

      assert.deepEqual(sessionRows.map((row) => row.action), ["create", "update"]);
      assert.equal(sessionRows[0].new.userId, "admin");
      assert.equal(sessionRows[1].new.active, false);
      assert.equal(emitted.some((change) => change.tableName === sessionTableName), false);

      const changes = await request(server, "GET", `/api/changes?since=${encodeURIComponent(since)}`, {
        basic: ["admin", "1234"],
      });
      assert.equal(changes.status, 200);
      assert.equal(changes.body.data.some((change) => change.tableName === sessionTableName), false);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("streams audit changes over sse", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({ seq, basePath: "/api", audit: true, modules });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);
    const stream = openSse(server, "/api/sse");

    try {
      await stream.connected;
      await api.services.get("clientes").create({ body: { nombre: "Sofia" } });

      const event = await stream.nextEvent;
      assert.equal(event.event, "audit");
      assert.equal(event.data.action, "create");
      assert.equal(event.data.tableName, "clientes");
      assert.equal(event.data.new.nombre, "Sofia");
    } finally {
      stream.close();
      await api.close();
      await close(server);
    }
  });

  it("streams audit updates over sse", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({ seq, basePath: "/api", audit: true, modules });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);
    const cliente = await api.services.get("clientes").create({ body: { nombre: "Sofia" } });
    const stream = openSse(server, "/api/sse");

    try {
      await stream.connected;
      await api.services.get("clientes").update({ params: { id: cliente.data.id }, body: { activo: false } });

      const event = await stream.nextEvent;
      assert.equal(event.event, "audit");
      assert.equal(event.data.action, "update");
      assert.equal(event.data.tableName, "clientes");
      assert.equal(event.data.old.activo, true);
      assert.equal(event.data.new.activo, false);
    } finally {
      stream.close();
      await api.close();
      await close(server);
    }
  });

  it("streams audit deletes over sse", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({ seq, basePath: "/api", audit: true, modules });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);
    const cliente = await api.services.get("clientes").create({ body: { nombre: "Sofia" } });
    const stream = openSse(server, "/api/sse");

    try {
      await stream.connected;
      await api.services.get("clientes").remove({ params: { id: cliente.data.id } });

      const event = await stream.nextEvent;
      assert.equal(event.event, "audit");
      assert.equal(event.data.action, "delete");
      assert.equal(event.data.tableName, "clientes");
      assert.equal(event.data.old.nombre, "Sofia");
      assert.deepEqual(event.data.new, {});
    } finally {
      stream.close();
      await api.close();
      await close(server);
    }
  });

  it("uses the configured audit sse heartbeat timeout", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({ seq, basePath: "/api", audit: { heartbeatTimeout: 10 }, modules });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);
    const stream = openSse(server, "/api/sse");

    try {
      await stream.connected;
      const comment = await timeoutAfter(stream.nextHeartbeat, 500, "SSE heartbeat not received");
      assert.equal(comment, "heartbeat");
    } finally {
      stream.close();
      await api.close();
      await close(server);
    }
  });

  it("closes authenticated sse streams when the bearer token expires", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      audit: { heartbeatTimeout: 50 },
      auth: { required: true, secret: "test-secret", tokenExpiresIn: "1s" },
      modules,
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });
    await seedAuditAuth(api.auth.models, { admin: ["audit.sse", "clientes.list"] });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const login = await request(server, "POST", "/api/login", {
        body: { username: "admin", password: "1234" },
      });
      assert.equal(login.status, 200);

      const stream = openSse(server, "/api/sse", { token: login.body.data.token });
      try {
        await stream.connected;
        const event = await timeoutAfter(stream.nextEvent, 1500, "SSE auth-expired event not received");
        assert.equal(event.event, "auth-expired");
        await timeoutAfter(stream.closed, 500, "SSE did not close after token expiration");
      } finally {
        stream.close();
      }
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("streams authenticated audit changes created inside service transactions", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      audit: { heartbeatTimeout: 50 },
      auth: { required: true, secret: "test-secret", tokenExpiresIn: "5m" },
      modules,
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });
    await seedAuditAuth(api.auth.models, { admin: ["audit.sse", "clientes.list"] });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const login = await request(server, "POST", "/api/login", {
        body: { username: "admin", password: "1234" },
      });
      assert.equal(login.status, 200);

      const stream = openSse(server, "/api/sse", { token: login.body.data.token });
      try {
        await stream.connected;
        await api.services.get("clientes").create({ body: { nombre: "Transaccion SSE" } });

        const event = await timeoutAfter(stream.nextEvent, 500, "SSE audit event not received");
        assert.equal(event.event, "audit");
        assert.equal(event.data.action, "create");
        assert.equal(event.data.tableName, "clientes");
        assert.equal(event.data.new.nombre, "Transaccion SSE");
      } finally {
        stream.close();
      }
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("closes authenticated sse streams when the iam session is deactivated", async () => {
    const adapter = new SQLiteAdapter({ database: ":memory:" });
    const seq = new Seq({ adapter, logging: false });
    const api = await createApiKit({
      seq,
      basePath: "/api",
      audit: { heartbeatTimeout: 20 },
      auth: { required: true, secret: "test-secret", tokenExpiresIn: "5m" },
      modules,
    });

    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });
    await seedAuditAuth(api.auth.models, { admin: ["audit.sse", "clientes.list"] });

    const app = express();
    app.use(express.json());
    app.use(api.router);
    app.use(api.errorHandler);

    const server = await listen(app);

    try {
      const login = await request(server, "POST", "/api/login", {
        body: { username: "admin", password: "1234" },
      });
      assert.equal(login.status, 200);

      const stream = openSse(server, "/api/sse", { token: login.body.data.token });
      try {
        await stream.connected;
        await api.auth.adapter.deactivateSession(login.body.data.id);
        const event = await timeoutAfter(stream.nextEvent, 500, "SSE session-closed event not received");
        assert.equal(event.event, "session-closed");
        await timeoutAfter(stream.closed, 500, "SSE did not close after session deactivation");
      } finally {
        stream.close();
      }
    } finally {
      await api.close();
      await close(server);
    }
  });
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function seedAuditAuth(models, users) {
  const permissionModels = new Map();
  const permissionNames = new Set(Object.values(users).flat());

  for (const permissionName of permissionNames) {
    const permission = await models.Permission.create({ permission: permissionName, active: true });
    permissionModels.set(permissionName, permission);
  }

  for (const [userId, permissions] of Object.entries(users)) {
    const user = await models.User.create({ id: userId, password: "1234", name: userId, email: `${userId}@example.com`, active: true });
    const role = await models.Role.create({ role: userId, active: true });
    await models.UserRole.create({ userId: user.getDataValue("id"), roleId: role.getDataValue("id"), active: true });

    for (const permissionName of permissions) {
      const permission = permissionModels.get(permissionName);
      await models.RolePermission.create({ roleId: role.getDataValue("id"), permissionId: permission.getDataValue("id"), active: true });
    }
  }
}

function request(server, method, path, options = {}) {
  const { port } = server.address();
  const headers = {};
  let body = null;
  if (options.basic) headers.Authorization = `Basic ${Buffer.from(options.basic.join(":")).toString("base64")}`;
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
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
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {}
        resolve({ status: res.statusCode, body, raw });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function tableNameForModel(ModelClass) {
  return ModelClass?._resolvedTableName || ModelClass?.tableName || ModelClass?.modelName || ModelClass?.name || "";
}

function openSse(server, path, options = {}) {
  const { port } = server.address();
  let req;
  let connectedResolve;
  let eventResolve;
  let eventReject;
  let heartbeatResolve;
  let heartbeatReject;
  let closedResolve;
  let closedReject;
  let manuallyClosed = false;
  let buffer = "";
  const headers = { Accept: "text/event-stream", ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.basic) headers.Authorization = `Basic ${Buffer.from(options.basic.join(":")).toString("base64")}`;

  const connected = new Promise((resolve) => {
    connectedResolve = resolve;
  });
  const nextEvent = new Promise((resolve, reject) => {
    eventResolve = resolve;
    eventReject = reject;
  });
  const nextHeartbeat = new Promise((resolve, reject) => {
    heartbeatResolve = resolve;
    heartbeatReject = reject;
  });
  const closed = new Promise((resolve, reject) => {
    closedResolve = resolve;
    closedReject = reject;
  });

  req = http.request({ hostname: "localhost", port, path, method: "GET", headers }, (res) => {
    assert.equal(res.statusCode, 200);
    connectedResolve();
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buffer += chunk;
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const rawEvent of events) {
        const comment = parseSseComment(rawEvent);
        if (comment === "heartbeat") heartbeatResolve(comment);
        const parsed = parseSseEvent(rawEvent);
        if (parsed) eventResolve(parsed);
      }
    });
    res.on("end", closedResolve);
    res.on("close", closedResolve);
    res.on("error", (error) => {
      if (manuallyClosed) return closedResolve();
      closedReject(error);
    });
  });
  req.on("error", (error) => {
    if (manuallyClosed && error.code === "ECONNRESET") {
      closedResolve();
      return;
    }
    eventReject(error);
    heartbeatReject(error);
    closedReject(error);
  });
  req.end();

  return {
    connected,
    nextEvent,
    nextHeartbeat,
    closed,
    close: () => {
      manuallyClosed = true;
      req.destroy();
    },
  };
}

function timeoutAfter(promise, timeout, message) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout);
  });
  timer.unref?.();
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeoutPromise]);
}

function parseSseComment(rawEvent) {
  const comment = rawEvent.split("\n").find((line) => line.startsWith(": "))?.slice(2);
  return comment || null;
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split("\n");
  const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
  const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
  if (!event || !data) return null;
  return { event, data: JSON.parse(data) };
}
