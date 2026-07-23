import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";
import { AppError } from "../errors/app-error.js";
import { ValidationError } from "../errors/validation-error.js";

export function normalizeInstallableApps(staticModules, baseDir) {
  return staticModules
    .filter((staticModule) => staticModule?.repo)
    .map((staticModule) => normalizeInstallableApp(staticModule, baseDir));
}

export async function installApp(app, { token, fetch: fetchImpl = globalThis.fetch } = {}) {
  try {
    const githubToken = stringValue(token) || process.env.GITHUB_TOKEN;
    const tag = app.version === "latest" ? await getLatestTag({ repo: app.repo, token: githubToken, fetch: fetchImpl }) : app.version;
    const installedTag = readInstalledTag(app.target);

    if (installedTag === tag) return installResult(app, tag, "skipped");

    const archive = await downloadArchive({ repo: app.repo, tag, token: githubToken, fetch: fetchImpl });
    await extractAndReplace({ app, archive, tag });
    return installResult(app, tag, "updated");
  } catch (error) {
    return { ...installResult(app, app.version, "failed"), error: error.message };
  }
}

export function renderInstallHtml(apps) {
  const rows = apps.map((app) => {
    return `<tr data-app="${escapeHtml(app.app)}">
      <td>${escapeHtml(app.app)}</td>
      <td>${escapeHtml(app.mountPath)}</td>
      <td>${escapeHtml(app.repo)}</td>
      <td>${escapeHtml(app.version)}</td>
      <td data-field="status"></td>
      <td data-field="tag"></td>
      <td data-field="error"></td>
      <td><button type="button" data-install="${escapeHtml(app.app)}">Actualizar</button></td>
    </tr>`;
  }).join("\n");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>api-kit install</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; color: #1f2937; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border-bottom: 1px solid #d1d5db; padding: .6rem; text-align: left; }
      button { cursor: pointer; padding: .4rem .7rem; }
      .failed { color: #b91c1c; }
      .updated { color: #047857; }
      .skipped { color: #4b5563; }
    </style>
  </head>
  <body>
    <h1>Instalar frontends</h1>
    <table>
      <thead>
        <tr><th>App</th><th>Path</th><th>Repo</th><th>Version</th><th>Status</th><th>Tag</th><th>Error</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <script>
      document.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-install]");
        if (!button) return;
        const app = button.dataset.install;
        const row = document.querySelector('[data-app="' + CSS.escape(app) + '"]');
        const set = (field, value) => row.querySelector('[data-field="' + field + '"]').textContent = value || "";
        button.disabled = true;
        row.className = "";
        set("status", "updating");
        set("tag", "");
        set("error", "");
        try {
          const basePath = window.location.pathname.endsWith("/") ? window.location.pathname : window.location.pathname + "/";
          const response = await fetch(basePath + encodeURIComponent(app), {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: "{}"
          });
          const payload = await response.json().catch(() => null);
          const data = payload && payload.data ? payload.data : {};
          if (!response.ok || !payload || payload.ok === false) throw new Error((payload && payload.message) || data.error || "Error");
          row.className = data.status || "";
          set("status", data.status);
          set("tag", data.tag);
          set("error", data.error);
        } catch (error) {
          row.className = "failed";
          set("status", "failed");
          set("error", error.message);
        } finally {
          button.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}

function normalizeInstallableApp(staticModule, baseDir) {
  assertRepo(staticModule.repo);

  const mountPath = normalizeMountPath(staticModule.mountPath || staticModule.pathPrefix || (staticModule.appName ? `/${staticModule.appName}` : null));
  if (!mountPath) throw new ValidationError("Static module instalable requiere mountPath", { errors: { mountPath: "Requerido" } });

  const publicRoot = path.resolve(baseDir, "public");
  const rootInput = staticModule.root || staticModule.dir || staticModule.directory || staticModule.path || (staticModule.appName ? `./public/${staticModule.appName}` : null);
  if (!rootInput) throw new ValidationError("Static module instalable requiere root", { errors: { root: "Requerido" } });

  const target = path.resolve(baseDir, rootInput);
  assertInsidePublic(target, publicRoot);

  return {
    app: appIdForMountPath(mountPath),
    mountPath,
    repo: staticModule.repo,
    version: stringValue(staticModule.version) || "latest",
    dist: stringValue(staticModule.dist) || "www",
    target,
    publicRoot,
  };
}

async function getLatestTag({ repo, token, fetch }) {
  const res = await githubFetch(`https://api.github.com/repos/${repo}/tags?per_page=1`, token, fetch);
  const tags = await res.json();
  if (!tags.length) throw new AppError("El repositorio no tiene tags.", { status: 404, code: "TAG_NOT_FOUND" });
  return tags[0].name;
}

async function downloadArchive({ repo, tag, token, fetch }) {
  const res = await githubFetch(`https://api.github.com/repos/${repo}/zipball/${encodeURIComponent(tag)}`, token, fetch);
  return Buffer.from(await res.arrayBuffer());
}

async function githubFetch(url, token, fetch) {
  if (typeof fetch !== "function") throw new AppError("fetch no esta disponible", { status: 500, code: "FETCH_NOT_AVAILABLE" });
  const headers = { "User-Agent": "api-kit", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new AppError(`GitHub respondio ${res.status}: ${await res.text()}`, { status: 502, code: "GITHUB_ERROR" });
  return res;
}

function readInstalledTag(target) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    return pkg.apiKitInstall?.tag || null;
  } catch {
    return null;
  }
}

async function extractAndReplace({ app, archive, tag }) {
  const extractDir = path.join(os.tmpdir(), `api-kit-${app.app}-${tag}-${Date.now()}`);
  const staging = path.join(app.publicRoot, `.install-${app.app}-${Date.now()}`);

  try {
    removeDir(extractDir);
    removeDir(staging);
    fs.mkdirSync(extractDir, { recursive: true });
    new AdmZip(archive).extractAllTo(extractDir, true);

    const rootFolder = firstDirectory(extractDir);
    if (!rootFolder) throw new AppError("El archivo descargado no contiene archivos", { status: 422, code: "EMPTY_ARCHIVE" });

    const repoRoot = path.join(extractDir, rootFolder);
    const distSrc = path.resolve(repoRoot, app.dist);
    assertInside(distSrc, repoRoot, "dist debe estar dentro del proyecto descargado");
    if (!fs.existsSync(distSrc)) throw new ValidationError(`No existe la carpeta ${app.dist} en el proyecto descargado.`);

    copyDir(distSrc, staging);
    writePackageJson({ repoRoot, staging, app, tag });
    replaceTarget({ source: staging, target: app.target, publicRoot: app.publicRoot });
  } finally {
    removeDir(extractDir);
    removeDir(staging);
  }
}

function writePackageJson({ repoRoot, staging, app, tag }) {
  let pkg = {};
  const pkgSrc = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgSrc)) pkg = JSON.parse(fs.readFileSync(pkgSrc, "utf8"));
  pkg.apiKitInstall = { repo: app.repo, tag, dist: app.dist, installedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(staging, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function replaceTarget({ source, target, publicRoot }) {
  assertInsidePublic(target, publicRoot);
  const backup = `${target}.backup-${Date.now()}`;

  try {
    removeDir(backup);
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    removeDir(backup);
  } catch (error) {
    if (fs.existsSync(target)) removeDir(target);
    if (fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    const srcFile = path.join(src, file);
    const destFile = path.join(dest, file);
    const stat = fs.statSync(srcFile);
    if (stat.isDirectory()) {
      copyDir(srcFile, destFile);
    } else {
      fs.copyFileSync(srcFile, destFile);
    }
  }
}

function firstDirectory(dir) {
  return fs.readdirSync(dir).find((entry) => fs.statSync(path.join(dir, entry)).isDirectory());
}

function removeDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function installResult(app, tag, status) {
  return { mountPath: app.mountPath, app: app.app, repo: app.repo, tag, target: app.target, status };
}

function appIdForMountPath(mountPath) {
  return mountPath.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

function normalizeMountPath(value) {
  if (!value) return null;
  const clean = String(value).trim();
  if (!clean) return null;
  return clean.startsWith("/") ? clean.replace(/\/+$/g, "") || "/" : `/${clean.replace(/\/+$/g, "")}`;
}

function assertRepo(repo) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repo || ""))) {
    throw new ValidationError("Repo debe tener formato owner/repo", { errors: { repo: "Formato invalido" } });
  }
}

function assertInsidePublic(target, publicRoot) {
  assertInside(target, publicRoot, "Target debe estar dentro de public");
}

function assertInside(target, root, message) {
  const relative = path.relative(root, target);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return;
  throw new ValidationError(message);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function stringValue(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}
