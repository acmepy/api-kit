import { createApiKit } from "api-kit/server";
import { Seq, SQLiteAdapter } from "seq";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const logger = {
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = path.join(rootDir, "example/data");
  await fs.mkdir(dataDir, { recursive: true });

  const adapter = new SQLiteAdapter({
    database: path.join(dataDir, "api-kit.sqlite"),
    naming: {
      tables: "snake_case",
      columns: "snake_case",
    }
  });
  const seq = new Seq({ adapter, logging:false });

  const api = await createApiKit({
    seq,
    basePath: "/api",
    modules: "./example/modules.js",
    auth: {
      secret: process.env.IAM_SECRET || "dev-secret",
      strategies: ["bearer", "basic"],
      tokenExpiresIn: process.env.IAM_TOKEN_EXPIRES_IN || "1h",
    },
    audit: true,
    openapi: true,
    postman: true,
    logging: logger,
  });

  api.app.use("/api-kit/client", express.static(path.join(rootDir, "src/client")));
  api.app.use("/vendor/yep", express.static(path.join(rootDir, "node_modules/yep/dist")));

  await seq.authenticate();
  await seq.sync();
  await seedIam(api);

  const port = process.env.PORT || 3000;
  api.app.listen(port, () => {
    console.log(`[api-kit] basic example running on http://localhost:${port}/basic`);
    console.log(`[api-kit] client example running on http://localhost:${port}/client`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function seedIam(api) {
  const models = api.auth?.models;
  if (!models) return;

  let user = await models.User.findByPk("admin");
  if (!user) {
    user = await models.User.create({
      id: "admin",
      password: "1234",
      name: "Admin",
      email: "admin@example.com",
      active: true,
    });
  }

  let role = await models.Role.findOne({ where: { role: "admin" } });
  if (!role) role = await models.Role.create({ role: "admin", active: true });

  const userId = user.get("id");
  const roleId = role.get("id");

  const userRole = await models.UserRole.findOne({ where: { userId, roleId } });
  if (!userRole) await models.UserRole.create({ userId, roleId, active: true });

  const permissionNames = new Set(api.routes.getAll().flatMap((route) => route.permissions || []));
  for (const permissionName of permissionNames) {
    let permission = await models.Permission.findOne({ where: { permission: permissionName } });
    if (!permission) permission = await models.Permission.create({ permission: permissionName, active: true });

    const permissionId = permission.get("id");
    const rolePermission = await models.RolePermission.findOne({ where: { roleId, permissionId } });
    if (!rolePermission) await models.RolePermission.create({ roleId, permissionId, active: true });
  }
}
