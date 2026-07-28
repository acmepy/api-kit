import { createApiKit } from "api-kit/server";
import { Seq, SQLiteAdapter } from "seq";

const logger = {
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

async function main() {
  const adapter = new SQLiteAdapter({
    database: ":memory:",
    naming: {
      tables: "snake_case",
      columns: "snake_case",
    },
  });
  const seq = new Seq({ adapter });

  const api = await createApiKit({
    seq,
    basePath: "/api",
    modules: "./example/modules.js",
    paths: {
      services: "./example/services",
    },
    auth: {
      secret: process.env.IAM_SECRET || "dev-secret",
      strategies: ["bearer", "basic"],
      tokenExpiresIn: process.env.IAM_TOKEN_EXPIRES_IN || "1h",
    },
    audit:true,
    openapi:false,
    postman: true,
    logging: logger,
  });

  await seq.authenticate();
  await seq.sync();
  await seedIam(api);

  const PORT = process.env.PORT || 3000;
  api.app.listen(PORT, () => {console.log(`[api-kit] demo running on http://localhost:${PORT}`)});
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
