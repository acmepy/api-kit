import express from "express";
import { createApiKit } from "../src/index.js";
import { Seq, SQLiteAdapter } from "seq";

async function main() {
  const adapter = new SQLiteAdapter({ database: ":memory:" });
  const seq = new Seq({ adapter });

  const app = express();
  app.use(express.json());

  const api = await createApiKit({
    seq,
    basePath: "/api",
    modules: "./example/modules.js",
    audit:true
  });

  await seq.authenticate();
  await seq.init();
  await seq.sync();

  app.use(api.router);
  app.use(api.errorHandler);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {console.log(`api-kit demo running on http://localhost:${PORT}`)});
}

main().catch(console.error);









