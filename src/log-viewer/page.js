import { readFileSync } from "node:fs";

const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

const assets = new URL("./assets/", import.meta.url);
const pages = {
  files: readFileSync(new URL("log-index.html", assets), "utf8"),
  view: readFileSync(new URL("log-view.html", assets), "utf8"),
};

export function renderPage(base, page) {
  return pages[page].replaceAll("{{base}}", () => escape(base));
}

export const stylesheet = readFileSync(new URL("viewer.css", assets), "utf8");
export const bootstrapStylesheet = readFileSync(new URL("bootstrap.min.css", assets), "utf8");
