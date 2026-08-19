import terser from "@rollup/plugin-terser";

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
    "logger",
    "seq",
    "vue",
    "yep",
  ].includes(id)
);

const bundles = [
  ["src/server/index.js", "dist/api-server"],
  ["src/client/index.js", "dist/api-client"],
  ["src/vue/index.js", "dist/api-vue"],
  ["src/cli/index.js", "dist/api-cli"],
];

function createBundle(input, outputName, shouldMinify = false) {
  return {
    input,
    external,
    plugins: shouldMinify ? [terser()] : [],
    output: {
      file: `${outputName}${shouldMinify ? ".min" : ""}.js`,
      format: "es",
      sourcemap: true,
    },
  };
}

const clientMinBundle = createBundle("src/client/index.js", "dist/api-client", true);

const outputs = minify
  ? [clientMinBundle]
  : [...bundles.map(([input, outputName]) => createBundle(input, outputName)), clientMinBundle];

export default outputs;
