import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JSDOM } from "jsdom";
import { createApi } from "../src/server/index.js";
import { normalizeUpdateMounts } from "../src/server/install/updates.services.js";
import { createTestSeq } from "./helpers/seq.js";

const fetch = (url, options = {}) => globalThis.fetch(url, {
  ...options, headers: { Authorization: `Basic ${Buffer.from("admin:1234").toString("base64")}`, ...options.headers },
});

async function fixture(t, updates, auth = { secret: "updates-test-secret", strategies: ["basic", "bearer"], logging: false }) {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "api-kit-updates-"));
  for (const dir of ["android/nested", "electron", "private"]) await mkdir(path.join(baseDir, dir), { recursive: true });
  for (const [name, content] of Object.entries({ "android/app.apk": "ANDROID", "android/a&b'.apk": "APK", "android/.hidden.apk": "HIDDEN", "android/nested/version.apk": "NESTED", "electron/app.exe": "ELECTRON", "electron/latest.yml": "version: 1.2.3", "private/secret.txt": "SECRET" })) await writeFile(path.join(baseDir, name), content);
  const seq = createTestSeq({ logging: false });
  const api = await createApi({ seq, baseDir, basePath: "/api", updates, auth });
  if (api.auth) {
    await seq.authenticate();
    await seq.init();
    await seq.sync({ force: true });
    await api.auth.models.users.create({ id: "admin", password: "1234", name: "Admin", active: true });
  }
  const server = await new Promise(resolve => { const listener = api.app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(async () => {
    await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(baseDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(baseDir).startsWith("api-kit-updates-"));
    await rm(baseDir, { recursive: true, force: true });
  });
  return { baseDir, api, url: `http://127.0.0.1:${server.address().port}` };
}

const mounts = [
  { mountPath: "/actualizaciones/android", root: "./android", index: true },
  { mountPath: "/actualizaciones/electron", root: "./electron", index: false },
];

it("requires authentication for indexes, files, HEAD and ranges, including when auth is not configured", async t => {
  const { url } = await fixture(t, { enabled: true, mounts });
  for (const [target, options] of [
    ["android/", {}], ["android/app.apk", {}], ["electron/latest.yml", {}],
    ["android/app.apk", { method: "HEAD" }], ["android/app.apk", { headers: { Range: "bytes=0-2" } }],
    ["android/app.apk", { headers: { Authorization: "Bearer invalid" } }],
    ["android/app.apk", { headers: { Authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}` } }],
  ]) assert.equal((await globalThis.fetch(`${url}/actualizaciones/${target}`, options)).status, 401);

  const login = await globalThis.fetch(`${url}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "1234" }),
  });
  assert.equal(login.status, 200);
  const { data } = await login.json();
  const headers = { Authorization: `Bearer ${data.token}` };
  assert.equal((await globalThis.fetch(`${url}/actualizaciones/android/`, { headers })).status, 200);
  assert.equal((await globalThis.fetch(`${url}/actualizaciones/android/app.apk`, { headers })).status, 200);
  assert.equal((await globalThis.fetch(`${url}/api/logout`, { method: "POST", headers })).status, 200);
  assert.equal((await globalThis.fetch(`${url}/actualizaciones/android/app.apk`, { headers })).status, 401);

  const noAuth = await fixture(t, { enabled: true, mounts }, false);
  assert.equal((await fetch(`${noAuth.url}/actualizaciones/android/app.apk`)).status, 401);
  assert.equal((await fetch(`${noAuth.url}/actualizaciones/android/`)).status, 401);
});

it("does not expose updates unless enabled is explicitly true", async t => {
  for (const config of [undefined, false, { mounts }, { enabled: false, mounts }]) {
    const { url } = await fixture(t, config);
    assert.equal((await fetch(`${url}/actualizaciones/android/app.apk`)).status, 404);
    assert.equal((await fetch(`${url}/actualizaciones/android/`)).status, 404);
  }
});

it("serves independent Android/Electron files, metadata, HEAD and byte ranges at the configured paths", async t => {
  const { url } = await fixture(t, { enabled: true, mounts });
  const apk = await fetch(`${url}/actualizaciones/android/app.apk`);
  assert.equal(apk.status, 200);
  assert.equal(await apk.text(), "ANDROID");
  assert.equal(await (await fetch(`${url}/actualizaciones/electron/app.exe`)).text(), "ELECTRON");
  assert.equal(await (await fetch(`${url}/actualizaciones/electron/latest.yml`)).text(), "version: 1.2.3");
  assert.equal((await fetch(`${url}/actualizaciones/android/app.exe`)).status, 404);
  assert.equal((await fetch(`${url}/api/actualizaciones/android/app.apk`)).status, 404, "mountPath is independent of basePath");
  const head = await fetch(`${url}/actualizaciones/android/app.apk`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "7");
  assert.equal(await head.text(), "");
  const range = await fetch(`${url}/actualizaciones/android/app.apk`, { headers: { Range: "bytes=0-2" } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "AND");
  assert.equal((await fetch(`${url}/actualizaciones/android/app.apk`, { method: "POST" })).status, 405);
});

it("provides an optional escaped directory index and supports nested directories without SPA fallback", async t => {
  const { url } = await fixture(t, { enabled: true, mounts });
  const response = await fetch(`${url}/actualizaciones/android`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const dom = new JSDOM(await response.text());
  const links = [...dom.window.document.querySelectorAll("a")];
  assert.ok(links.some(link => link.textContent === "a&b'.apk" && link.getAttribute("href").includes("a%26b")));
  assert.ok(links.some(link => link.textContent === "nested/"));
  assert.equal(links.some(link => link.textContent === ".hidden.apk"), false);
  dom.window.close();
  assert.equal(await (await fetch(`${url}/actualizaciones/android/nested/version.apk`)).text(), "NESTED");
  assert.match(await (await fetch(`${url}/actualizaciones/android/nested/`)).text(), /version\.apk/);
  assert.equal((await fetch(`${url}/actualizaciones/electron/`)).status, 404);
  assert.equal((await fetch(`${url}/actualizaciones/android/missing-route`)).status, 404);
  assert.equal((await fetch(`${url}/actualizaciones/android/.hidden.apk`)).status, 404);
});

it("blocks traversal and symlinks pointing outside the mounted directory", async t => {
  const { baseDir, url } = await fixture(t, { enabled: true, mounts });
  for (const target of ["%2e%2e%2fprivate/secret.txt", "..%5cprivate%5csecret.txt", "%00", ".hidden.apk"]) {
    assert.equal((await fetch(`${url}/actualizaciones/android/${target}`)).status, 404);
  }
  await symlink(path.join(baseDir, "private"), path.join(baseDir, "android/escape"), "junction");
  assert.equal((await fetch(`${url}/actualizaciones/android/escape/secret.txt`)).status, 404);
  assert.doesNotMatch(await (await fetch(`${url}/actualizaciones/android/`)).text(), /escape/);
});

it("can serve a configured directory created after startup and defaults index to false", async t => {
  const { baseDir, url } = await fixture(t, { enabled: true, mounts: [{ mountPath: "/later", root: "./later" }] });
  assert.equal((await fetch(`${url}/later/update.apk`)).status, 404);
  await mkdir(path.join(baseDir, "later")); await writeFile(path.join(baseDir, "later/update.apk"), "READY");
  assert.equal(await (await fetch(`${url}/later/update.apk`)).text(), "READY");
  assert.equal((await fetch(`${url}/later/`)).status, 404);
});

it("validates update mounts and resolves relative roots against baseDir", () => {
  const base = path.resolve("tests");
  assert.equal(normalizeUpdateMounts({ enabled: true, mounts: [{ mountPath: "updates/", root: "files" }] }, base)[0].root, path.join(base, "files"));
  for (const config of [true, { enabled: "true" }, { enabled: true }, { enabled: true, mounts: [] },
    { enabled: true, mounts: [{ root: "files" }] }, { enabled: true, mounts: [{ mountPath: "/updates" }] },
    { enabled: true, mounts: [{ mountPath: "/updates/:file", root: "files" }] },
    { enabled: true, mounts: [mounts[0], mounts[0]] },
    { enabled: true, mounts: [{ mountPath: "/updates", root: "files", index: "true" }] },
  ]) assert.throws(() => normalizeUpdateMounts(config, base));
});
