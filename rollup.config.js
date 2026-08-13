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
    "yep",
  ].includes(id)
);

const bundles = [
  ["src/server/index.js", "dist/api-kit-server"],
  ["src/client/index.js", "dist/api-kit-client"],
  ["src/cli/index.js", "dist/api-kit-cli"],
];

export default bundles.map(([input, outputName]) => ({
  input,
  external,
  plugins: minify ? [terser()] : [],
  output: {
    file: `${outputName}${minify ? ".min" : ""}.js`,
    format: "es",
    sourcemap: true
  },
}));
