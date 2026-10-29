import terser from "@rollup/plugin-terser";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const versionModule = fileURLToPath(new URL("./src/version.js", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

function packageVersion() {
  return {
    name: "package-version",
    load(id) {
      if (id === versionModule) return `export const version = ${JSON.stringify(version)};`;
    },
  };
}

const minify = process.env.MINIFY === "true";

const external = (id) => (
  id.startsWith("node:") ||
  [
    "adm-zip",
    "compression",
    "cors",
    "express",
    "express-rate-limit",
    "helmet",
    "iam",
    "iam/adapters",
    "iam/express",
    "idb-keyval",
    "logger",
    "seq",
    "vue",
    "yep",
  ].includes(id)
);

const bundles = [
  ["src/server/index.js", "dist/api-server", "api-server.d.ts"],
  ["src/client/index.js", "dist/api-client", "api-client.d.ts"],
  ["src/vue/index.js", "dist/api-vue", "api-vue.d.ts"],
  ["src/cli/index.js", "dist/api-cli", "api-cli.d.ts"],
  ["src/log-viewer/index.js", "dist/api-log-viewer", "api-log-viewer.d.ts"],
];

function declarationFile(source, fileName) {
  return {
    name: `declaration:${fileName}`,
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName,
        source: readFileSync(source, "utf8"),
      });
    },
  };
}

function createBundle(input, outputName, declaration, shouldMinify = false) {
  return {
    input,
    external,
    plugins: [
      packageVersion(),
      declarationFile(`types/${declaration}`, declaration),
      ...(["src/server/index.js", "src/log-viewer/index.js"].includes(input) ? [logViewerAssets()] : []),
      ...(shouldMinify ? [terser()] : []),
    ],
    output: {
      file: `${outputName}${shouldMinify ? ".min" : ""}.js`,
      format: "es",
      sourcemap: true,
    },
  };
}

function logViewerAssets() {
  return {
    name: "log-viewer-assets",
    generateBundle() {
      for (const name of readdirSync("src/log-viewer/assets")) {
        this.emitFile({ type: "asset", fileName: `assets/${name}`, source: readFileSync(`src/log-viewer/assets/${name}`) });
      }
    },
  };
}

const clientMinBundle = createBundle("src/client/index.js", "dist/api-client", "api-client.d.ts", true);

const outputs = minify
  ? [clientMinBundle]
  : [...bundles.map(([input, outputName, declaration]) => createBundle(input, outputName, declaration)), clientMinBundle];

export default outputs;
