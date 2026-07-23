import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import AdmZip from "adm-zip";
import { Seq, SQLiteAdapter } from "seq";
import { createApiKit } from "../src/index.js";
import { installApp, normalizeInstallableApps, renderInstallHtml } from "../src/install/install.services.js";

describe("installable static modules", () => {
  it("detects apps by repo and applies defaults", async () => {
    const baseDir = await tempBaseDir();
    const apps = normalizeInstallableApps(
      [
        { mountPath: "/portal", root: "./public/portal", repo: "acmepy/sifen-portal" },
        { mountPath: "/admin/app", root: "./public/admin-app", repo: "acmepy/sifen-admin", version: "v1.0.0", dist: "build" },
        { mountPath: "/plain", root: "./public/plain" },
      ],
      baseDir,
    );

    assert.equal(apps.length, 2);
    assert.equal(apps[0].app, "portal");
    assert.equal(apps[0].version, "latest");
    assert.equal(apps[0].dist, "www");
    assert.equal(apps[1].app, "admin-app");
    assert.equal(apps[1].version, "v1.0.0");
    assert.equal(apps[1].dist, "build");
  });

  it("rejects invalid repo and targets outside public", async () => {
    const baseDir = await tempBaseDir();

    assert.throws(
      () => normalizeInstallableApps([{ mountPath: "/portal", root: "./public/portal", repo: "sifen-portal" }], baseDir),
      /owner\/repo/,
    );
    assert.throws(
      () => normalizeInstallableApps([{ mountPath: "/portal", root: "./private/portal", repo: "acmepy/sifen-portal" }], baseDir),
      /public/,
    );
  });

  it("skips when the installed tag matches latest", async () => {
    const baseDir = await tempBaseDir();
    const target = path.join(baseDir, "public", "portal");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "package.json"), JSON.stringify({ apiKitInstall: { tag: "v1.2.0" } }));

    const [app] = normalizeInstallableApps([{ mountPath: "/portal", root: "./public/portal", repo: "acmepy/sifen-portal" }], baseDir);
    const calls = [];
    const result = await installApp(app, {
      fetch: async (url) => {
        calls.push(url);
        return jsonResponse([{ name: "v1.2.0" }]);
      },
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.tag, "v1.2.0");
    assert.equal(result.target, "public/portal");
    assert.equal(calls.length, 1);
  });

  it("updates when the remote tag changed", async () => {
    const baseDir = await tempBaseDir();
    const target = path.join(baseDir, "public", "portal");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "package.json"), JSON.stringify({ apiKitInstall: { tag: "v1.0.0" } }));

    const archive = zipBuffer({
      "repo-root/package.json": JSON.stringify({ name: "sifen-portal", version: "1.2.0" }),
      "repo-root/www/index.html": "<h1>updated</h1>",
      "repo-root/www/app.js": "console.log('updated')",
    });
    const [app] = normalizeInstallableApps([{ mountPath: "/portal", root: "./public/portal", repo: "acmepy/sifen-portal" }], baseDir);
    const result = await installApp(app, {
      fetch: async (url) => String(url).includes("/tags") ? jsonResponse([{ name: "v1.2.0" }]) : bufferResponse(archive),
    });

    const index = await readFile(path.join(target, "index.html"), "utf8");
    const pkg = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));

    assert.equal(result.status, "updated");
    assert.equal(result.tag, "v1.2.0");
    assert.equal(result.target, "public/portal");
    assert.match(index, /updated/);
    assert.equal(pkg.name, "sifen-portal");
    assert.equal(pkg.apiKitInstall.repo, "acmepy/sifen-portal");
    assert.equal(pkg.apiKitInstall.tag, "v1.2.0");
  });

  it("renders html that posts and displays status, tag, and errors", async () => {
    const html = renderInstallHtml([{ app: "portal", mountPath: "/portal", repo: "acmepy/sifen-portal", version: "latest" }]);

    assert.match(html, /data-install="portal"/);
    assert.match(html, /POST/);
    assert.match(html, /data\.status/);
    assert.match(html, /data\.tag/);
    assert.match(html, /data\.error/);
  });
});

describe("install routes", () => {
  it("does not expose install routes without installable static modules", async () => {
    const api = await testApi({ modules: [{ mountPath: "/portal", root: "./tests/fixtures/portal-app" }] });
    const server = await testServer(api);

    try {
      const index = await request(server, "GET", "/install/");
      const appInstall = await request(server, "POST", "/install/portal");

      assert.equal(index.status, 404);
      assert.equal(appInstall.status, 404);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("exposes installer html and openapi for installable static modules", async () => {
    const api = await testApi({
      basePath: "/api",
      openapi: {},
      modules: [{ mountPath: "/portal", root: "./public/portal", repo: "acmepy/sifen-portal" }],
    });
    const server = await testServer(api);

    try {
      const html = await request(server, "GET", "/install/");
      const openapi = await request(server, "GET", "/api/openapi.json");

      assert.equal(html.status, 200);
      assert.match(html.raw, /acmepy\/sifen-portal/);
      assert.match(html.raw, /data-install="portal"/);
      assert.ok(openapi.body.paths["/install/{app}"].post);
    } finally {
      await api.close();
      await close(server);
    }
  });

  it("requires global auth for install html and app updates", async () => {
    const baseDir = await tempBaseDir();
    const target = path.join(baseDir, "public", "portal");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "package.json"), JSON.stringify({ apiKitInstall: { tag: "v1.2.0" } }));

    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse([{ name: "v1.2.0" }]);

    const api = await testApi({
      baseDir,
      basePath: "/api",
      auth: { required: true, secret: "test-secret" },
      openapi: {},
      modules: [{ mountPath: "/portal", root: "./public/portal", repo: "acmepy/sifen-portal" }],
    });
    await seedIam(api.auth.models);
    const server = await testServer(api);

    try {
      const deniedHtml = await request(server, "GET", "/install/");
      const deniedPost = await request(server, "POST", "/install/portal", { body: {} });
      assert.equal(deniedHtml.status, 401);
      assert.equal(deniedPost.status, 401);

      const login = await request(server, "POST", "/api/login", { body: { username: "admin", password: "1234" } });
      const installed = await request(server, "POST", "/install/portal", { token: login.body.data.token, body: {} });

      assert.equal(installed.status, 200);
      assert.equal(installed.body.data.status, "skipped");
      assert.equal(installed.body.data.tag, "v1.2.0");
      assert.equal(installed.body.data.target, "public/portal");
    } finally {
      globalThis.fetch = previousFetch;
      await api.close();
      await close(server);
    }
  });
});

async function testApi(options) {
  const adapter = new SQLiteAdapter({ database: ":memory:" });
  const seq = new Seq({ adapter, logging: false });
  const api = await createApiKit({ seq, ...options });
  await seq.authenticate();
  await seq.init();
  await seq.sync({ force: true });
  return api;
}

async function testServer(api) {
  const app = express();
  app.use(express.json());
  app.use(api.router);
  app.use(api.errorHandler);
  return listen(app);
}

async function tempBaseDir() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "api-kit-install-"));
  await mkdir(path.join(baseDir, "public"), { recursive: true });
  return baseDir;
}

function zipBuffer(files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data };
}

function bufferResponse(buffer) {
  return { ok: true, status: 200, arrayBuffer: async () => buffer };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(server, method, requestPath, options = {}) {
  const { port } = server.address();
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  let body = null;

  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "localhost", port, path: requestPath, method, headers }, (res) => {
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

async function seedIam(models) {
  const user = await models.User.create({ id: "admin", password: "1234", name: "Admin", email: "admin@example.com", active: true });
  const role = await models.Role.create({ role: "admin", active: true });
  await models.UserRole.create({ userId: user.getDataValue("id"), roleId: role.getDataValue("id"), active: true });
}
