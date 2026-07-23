import express from "express";
import { createApiKit } from "../src/index.js";
import { Seq, SQLiteAdapter } from "seq";

async function main() {
  const adapter = new SQLiteAdapter({
    database: ":memory:",
    naming: {
      tables: "snake_case",
      columns: "snake_case",
    },
  });
  const seq = new Seq({ adapter });

  const app = express();
  app.use(express.json());

  const api = await createApiKit({
    seq,
    basePath: "/api",
    modules: "./example/modules.js",
    paths: {
      services: "./example/services",
    },
    auth: { secret: process.env.IAM_SECRET || "dev-secret" },
    audit:true,
    openapi: true,
  });

  await seq.authenticate();
  await seq.sync();
  await seedIam(api);

  app.use(api.router);
  app.use(api.errorHandler);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {console.log(`api-kit demo running on http://localhost:${PORT}`)});
}

main().catch(console.error);

async function seedIam(api) {
  const models = api.auth?.models;
  if (!models) return;

  const existing = await models.User.findByPk("admin");
  if (existing) return;

  const permissions = new Map();
  for (const permissionName of new Set(api.routes.getAll().flatMap((route) => route.permissions || []))) {
    const permission = await models.Permission.create({ permission: permissionName, active: true });
    permissions.set(permissionName, permission);
  }

  for (const d of ["admin", "basic"]){
    const user = await models.User.create({ id: d, password: "1234", name: d[0].toLocaleUpperCase()+d.substring(1), email: "admin@example.com", active: true });
    const role = await models.Role.create({ role: d, active: true });
    await models.UserRole.create({userId: user.getDataValue("id"), roleId: role.getDataValue("id"), active: true});

    for (const [permissionName, permission] of permissions) {
      if(d !== "admin" && permissionName!="clientes.list" && permissionName.indexOf("clientes")>=0) continue;
      await models.RolePermission.create({ roleId: role.getDataValue("id"), permissionId: permission.getDataValue("id"), active: true });
    }
  }
}


