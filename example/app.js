import express from "express";
import { createApiKit, defineResource } from "../src/index.js";
import { Seq, SQLiteAdapter } from "seq";

const clienteResource = defineResource({
  modelName: "Cliente",
  tableName: "clientes",
  timestamps: true,
  attributes: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    nombre: { type: "string", maxLength: 100, allowNull: false, title: "Nombre", max: 100 },
    email: { type: "string", maxLength: 150, unique: true, allowNull: true, title: "Email", email: true },
    activo: { type: "boolean", defaultValue: true, title: "Activo" },
  },
});

const productoResource = defineResource({
  modelName: "Producto",
  tableName: "productos",
  timestamps: true,
  attributes: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    descripcion: { type: "string", maxLength:120,  allowNull: false, title:"Nombre", max:120},
    precio: { type:'decimal', precision:12, scale:2, allowNull: false, defaultValue: 0, title:"Precio", min: 0},
    activo: {type: 'boolean', defaultValue: true, title:"Activo"}
  },
});

async function main() {
  const adapter = new SQLiteAdapter({ database: ":memory:" });
  const seq = new Seq({ adapter, models: [clienteResource.model, productoResource.model] });

  await seq.authenticate();
  await seq.init();
  await seq.sync({ force: true });

  const app = express();
  app.use(express.json());

  const api = await createApiKit({
    seq,
    //baseDir: process.cwd(),
    basePath: "/api",
    modules: [
      {
        name: "clientes",
        basePath: "/clientes",
        resource: clienteResource,
        description: "Gestion de clientes",
        tags: ["Clientes"],
        endpoints: {
          list: { permission: "clientes.list" },
          get: { permission: "clientes.read" },
          create: { permission: "clientes.create" },
          update: { permission: "clientes.update" },
          remove: { permission: "clientes.delete" },
        },
      },
      {
        name: "productos",
        basePath: "/productos",
        resource: productoResource,
        //schema: false,
      },
    ],
  });

  app.use(api.router);
  app.use(api.errorHandler);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {console.log(`api-kit demo running on http://localhost:${PORT}`)});
}

main().catch(console.error);









