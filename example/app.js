import { createApi } from "api/server";
import { SeqAdapter } from "iam/adapters";
import { createLogger, logger, LEVELS } from "logger";
import { MySQLAdapter, Seq, SQLiteAdapter } from "seq";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

createLogger({ name: "[api]", displayConsole: true, level: LEVELS.INFO });

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = path.join(rootDir, "example/data");
  await fs.mkdir(dataDir, { recursive: true });

  const adapter = createAdapter({ dataDir });
  const seq = new Seq({ adapter, logging:false });
  const iamAdapter = new SeqAdapter({ seq });

  const api = await createApi({
    seq,
    basePath: "/api",
    modules: "./example/modules.js",
    auth: {
      adapter: iamAdapter,
      secret: process.env.IAM_SECRET || "dev-secret",
      strategies: ["bearer", "basic"],
      tokenExpiresIn: process.env.IAM_TOKEN_EXPIRES_IN || "1h",
    },
    audit: true,
    openapi: true,
    schema: { auth: true },
    postman: true,
    logging: logger,
  });

  api.app.use("/api/dist", express.static(path.join(rootDir, "dist")));
  api.app.use("/vendor/yep", express.static(path.join(rootDir, "node_modules/yep/dist")));
  api.app.use("/vendor/vue", express.static(path.join(rootDir, "node_modules/vue/dist")));

  await seq.authenticate();
  await seq.sync();
  await seedIam(api);

  const port = process.env.PORT || 3000;
  api.app.listen(port, () => {
    console.log(`[api] adapter: ${adapterName()}`);
    console.log(`[api] basic example running on http://localhost:${port}/basic`);
  console.log(`[api] client example running on http://localhost:${port}/client`);
  console.log(`[api] Vue example running on http://localhost:${port}/vue`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function createAdapter({ dataDir }) {
  const naming = {
    tables: "snake_case",
    columns: "snake_case",
  };

  if (adapterName() === "mysql") {
    return new MySQLAdapter({
      host: process.env.MYSQL_HOST || "localhost",
      port: numberEnv("MYSQL_PORT", 3306),
      user: process.env.MYSQL_USER || "root",
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE || "seq",
      connectTimeout: numberEnv("MYSQL_CONNECT_TIMEOUT", 10000),
      connectionLimit: numberEnv("MYSQL_CONNECTION_LIMIT", 10),
      naming,
    });
  }

  return new SQLiteAdapter({database: process.env.SQLITE_DATABASE || path.join(dataDir, "api.sqlite"), naming});
}

function adapterName() {
  const value = process.env.API_KIT_ADAPTER || process.env.SEQ_ADAPTER || (process.env.SEQ_MYSQL_TEST ? "mysql" : "sqlite");
  return String(value).toLowerCase();
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

async function seedIam(api) {
  const models = api.auth?.models;
  if (!models) return;

  let user = await models.users.findByPk("admin");
  if (!user) {
    user = await models.users.create({
      id: "admin",
      password: "1234",
      name: "Admin",
      email: "admin@example.com",
      active: true,
    });
  }

  let role = await models.roles.findOne({ where: { role: "admin" } });
  if (!role) role = await models.roles.create({ role: "admin", active: true });

  const userId = user.get("id");
  const roleId = role.get("id");

  const userRole = await models.usersRoles.findOne({ where: { userId, roleId } });
  if (!userRole) await models.usersRoles.create({ userId, roleId, active: true });

  const permissionNames = new Set(api.routes.getAll().flatMap((route) => route.permissions || []));
  for (const permissionName of permissionNames) {
    let permission = await models.permissions.findOne({ where: { permission: permissionName } });
    if (!permission) permission = await models.permissions.create({ permission: permissionName, active: true });

    const permissionId = permission.get("id");
    const rolePermission = await models.rolesPermissions.findOne({ where: { roleId, permissionId } });
    if (!rolePermission) await models.rolesPermissions.create({ roleId, permissionId, active: true });
  }
}
