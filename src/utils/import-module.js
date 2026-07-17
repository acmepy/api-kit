import { pathToFileURL } from "node:url";
import path from "node:path";

export async function importModule(filePath) {
  const absolute = path.resolve(filePath);
  const url = pathToFileURL(absolute).href;
  const mod = await import(url);
  return mod.default || mod;
}

export async function fileExists(filePath) {
  const { access } = await import("node:fs/promises");
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
