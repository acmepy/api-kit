import { readFileSync } from "node:fs";

const assets = new URL("./assets/", import.meta.url);
const page = readFileSync(new URL("import-page.html", assets), "utf8");
export const importStylesheet = readFileSync(new URL("import-page.css", assets), "utf8");
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function renderImportPage(config) {
  return page.replaceAll("{{title}}", () => escape(config.description || config.name))
    .replaceAll("{{importUrl}}", () => escape(config.basePath + config.endpoints.import.path))
    .replaceAll("{{templateUrl}}", () => escape(config.basePath + config.endpoints.importTemplate.path));
}
