import express from "express";
import { createApiKit } from "../src/api-kit.js";
import { Seq, SQLiteAdapter, Model, DataTypes } from "seq";
import yep from "yep";

class Cliente extends Model {
  static define(seq) {
    return this.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        nombre: { type: DataTypes.STRING(100), allowNull: false },
        email: { type: DataTypes.STRING(150), unique:true, allowNull: true },
        activo: { type: DataTypes.BOOLEAN, defaultValue: true },
      },
      {
        seq,
        modelName: "Cliente",
        tableName: "clientes",
        timestamps: true,
      },
    );
  }
}

async function main() {
  const adapter = new SQLiteAdapter({ database: ":memory:" });
  const seq = new Seq({ adapter, models: [Cliente] });

  await seq.authenticate();
  await seq.init();
  await seq.sync({ force: true });

  const app = express();
  app.use(express.json());

  const api = await createApiKit({
    seq,
    baseDir: process.cwd(),
    models: { Cliente },
    modules: [
      {
        name: "clientes",
        basePath: "/api/clientes",
        model: "Cliente",
        description: "Gestión de clientes",
        tags: ["Clientes"],
        schemas: {
          create: yep.object({
            nombre: yep.string().label("Nombre").required().max(100),
            email: yep.string().label("Email").email().nullable(),
            activo: yep.boolean().label("Activo"),
          }),
          update: yep.object({
            nombre: yep.string().label("Nombre").max(100),
            email: yep.string().label("Email").email().nullable(),
            activo: yep.boolean().label("Activo"),
          }),
        },
        endpoints: {
          list: { enabled: true, permission: "clientes.list" },
          getById: { enabled: true, permission: "clientes.read" },
          create: { enabled: true, permission: "clientes.create" },
          update: { enabled: true, permission: "clientes.update" },
          remove: { enabled: true, permission: "clientes.delete" },
        },
      },
    ],
  });

  app.use(api.router);
  app.use(api.errorHandler);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`api-kit demo running on http://localhost:${PORT}`);
    console.log(`  GET    /api/clientes`);
    console.log(`  GET    /api/clientes/:id`);
    console.log(`  POST   /api/clientes`);
    console.log(`  PUT    /api/clientes/:id`);
    console.log(`  DELETE /api/clientes/:id`);
  });
}

main().catch(console.error);

