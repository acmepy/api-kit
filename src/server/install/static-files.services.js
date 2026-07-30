import path from "node:path";
import express from "express";
import { normalizeMountPath } from "../utils/normalize.js";

export function installStaticFiles(router, config) {
  for (const staticConfig of config.staticModules) {
    const normalized = normalizeStaticFileConfig(staticConfig, config.baseDir);
    if (!normalized) continue;

    router.use(normalized.mountPath, express.static(normalized.root, normalized.options));
    if (!normalized.spa) continue;

    router.get(new RegExp(`^${escapeRegExp(normalized.mountPath)}(?:/.*)?$`), (req, res, next) => {
      if (/\.[^/]+$/.test(req.path)) return next();
      res.sendFile(path.join(normalized.root, normalized.index));
    });
  }
}

export function normalizeStaticFileConfig(config, baseDir) {
  if (!config) return null;
  const value = typeof config === "string" ? { appName: config } : config;
  const mountPath = normalizeMountPath(value.mountPath || value.pathPrefix || (value.appName ? `/${value.appName}` : null));
  const rootInput = value.root || value.dir || value.directory || value.path || (value.appName ? `./public/${value.appName}` : null);
  if (!mountPath || !rootInput) return null;
  return {mountPath, root: path.resolve(baseDir, rootInput), spa: value.spa ?? true, index: value.index || "index.html", options: { redirect: false, ...value.options }};
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
