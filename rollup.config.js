import terser from "@rollup/plugin-terser";
import { readFileSync } from "node:fs";

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
    plugins: [declarationFile(`types/${declaration}`, declaration), ...(shouldMinify ? [terser()] : [])],
    output: {
      file: `${outputName}${shouldMinify ? ".min" : ""}.js`,
      format: "es",
      sourcemap: true,
    },
  };
}

const clientMinBundle = createBundle("src/client/index.js", "dist/api-client", "api-client.d.ts", true);

const outputs = minify
  ? [clientMinBundle]
  : [...bundles.map(([input, outputName, declaration]) => createBundle(input, outputName, declaration)), clientMinBundle];

export default outputs;
