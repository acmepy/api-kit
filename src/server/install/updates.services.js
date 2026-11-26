import path from "node:path";
import { realpath, readdir } from "node:fs/promises";
import express from "express";
import { ConfigError } from "../errors/config-error.js";
import { normalizeMountPath } from "../utils/normalize.js";

export function normalizeUpdateMounts(updates, baseDir) {
  if (updates == null || updates === false) return [];
  if (typeof updates !== "object" || Array.isArray(updates) || (updates.enabled !== undefined && typeof updates.enabled !== "boolean")) throw new ConfigError("updates debe ser un objeto con enabled booleano");
  if (updates.enabled !== true) return [];
  if (!Array.isArray(updates.mounts) || updates.mounts.length === 0) throw new ConfigError("updates.mounts requiere al menos un directorio");
  const paths = new Set();
  return updates.mounts.map(mount => {
    if (!mount || typeof mount.mountPath !== "string" || !mount.mountPath.trim() || typeof mount.root !== "string" || !mount.root.trim()) throw new ConfigError("Cada montaje de updates requiere mountPath y root");
    const mountPath = normalizeMountPath(mount.mountPath);
    if (/[?#\\:*()[\]{}%]/.test(mountPath) || mountPath.split("/").some(part => part === "." || part === "..")) throw new ConfigError("updates.mountPath debe ser una ruta literal");
    if (paths.has(mountPath)) throw new ConfigError(`Montaje de updates repetido: ${mountPath}`);
    if (mount.index !== undefined && typeof mount.index !== "boolean") throw new ConfigError("updates.index debe ser booleano");
    paths.add(mountPath);
    return { mountPath, root: path.resolve(baseDir, mount.root), index: mount.index === true };
  }).sort((a, b) => b.mountPath.length - a.mountPath.length);
}

export function installUpdateRoutes(router, mounts, authorize) {
  for (const mount of mounts) {
    const files = express.static(mount.root, { index: false, redirect: false, dotfiles: "ignore", fallthrough: false });
    router.use(mount.mountPath, authorize({ auth: { required: true } }), async (req, res, next) => {
      if (!["GET", "HEAD"].includes(req.method)) return res.set("Allow", "GET, HEAD").sendStatus(405);
      let decoded;
      try { decoded = decodeURIComponent(req.path); }
      catch { return res.sendStatus(400); }
      if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes(":")) return res.sendStatus(404);
      if (decoded.split("/").some(part => part.startsWith(".") && part !== "")) return res.sendStatus(404);
      try {
        const root = await realpath(mount.root);
        const target = await realpath(path.resolve(root, `.${decoded}`));
        const relative = path.relative(root, target);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return res.sendStatus(404);
        if (mount.index) {
          let entries;
          try { entries = await readdir(target, { withFileTypes: true }); }
          catch (error) { if (error.code !== "ENOTDIR") throw error; }
          if (entries) {
            const base = `${req.baseUrl}${req.path.replace(/\/?$/, "/")}`;
            res.set("Cache-Control", "no-store");
            return res.type("html").send(directoryIndex(base, entries));
          }
        }
        return files(req, res, next);
      } catch (error) {
        if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) return res.sendStatus(error.code === "EACCES" || error.code === "EPERM" ? 403 : 404);
        return next(error);
      }
    });
  }
}

function directoryIndex(base, entries) {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const links = entries.filter(entry => !entry.name.startsWith(".") && (entry.isFile() || entry.isDirectory()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => {
      const suffix = entry.isDirectory() ? "/" : "";
      return `<li><a href="${escape(base + encodeURIComponent(entry.name) + suffix)}">${escape(entry.name + suffix)}</a></li>`;
    }).join("\n");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Actualizaciones</title></head><body><h1>Actualizaciones</h1><ul>${links}</ul></body></html>`;
}
