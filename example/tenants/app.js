import express from "express";
import { Seq, SQLiteAdapter } from "seq";
import { createApi, getContext } from "api/server";
import { mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import modules from "./modules.js";
import { definePlans, installAdministration } from "./administration.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../..");

export async function start({ port = Number(process.env.TENANT_PORT || 3001), database } = {}) {
  if (!database) {
    const data = path.join(root, "example/data/tenants");
    await mkdir(data, { recursive: true });
    database = path.join(data, "tenants.sqlite");
  }
  const seq = new Seq({ adapter: new SQLiteAdapter({ database }), getContext,
    tenant: { attribute: "codEmpresa" }, logging: false });
  let api;
  let server;
  const close = async () => {
    await api?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await seq.close();
  };
  try {
    api = await createApi({ seq, modules, basePath: "/api", tenant: { attribute: "codEmpresa" },
      paths: { services: path.join(directory, "services") },
      auth: { secret: process.env.TENANT_SECRET || "tenant-example-development-secret" },
      schema: true, audit: true });
    const plans = definePlans(seq);
    installAdministration(api, plans);
    api.app.use("/assets/api", express.static(path.join(root, "dist")));
    api.app.use("/assets/yep", express.static(path.join(root, "node_modules/yep/dist")));
    api.app.use("/assets/idb-keyval", express.static(path.join(root, "node_modules/idb-keyval/dist")));
    api.app.use("/assets/bootstrap", express.static(path.join(root, "node_modules/bootstrap/dist")));
    api.app.use(express.static(directory, { index: "index.html", dotfiles: "deny" }));
    await seq.authenticate();
    await seq.init();
    await seq.sync();
    await seed(api, plans);
    server = await new Promise((resolve, reject) => {
      const listener = api.app.listen(port, "127.0.0.1", () => resolve(listener));
      listener.once("error", reject);
    });
    return { api, seq, server, url: `http://127.0.0.1:${server.address().port}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function seed(api, plans) {
  const m = api.auth.models;
  for (const [id, name] of [[1, "Empresa Norte"], [2, "Empresa Sur"]]) {
    if (!await m.tenants.findByPk(id)) await m.tenants.create({ id, name });
    if (!await plans.findByPk(id)) await plans.create({ tenantId: id, maxFacturas: 10 });
  }
  if (!await m.users.findByPk("demo")) {
    await m.users.create({ id: "demo", name: "Demo tenants", password: "1234", tenantId: 1 });
  }
  if (!await m.users.findByPk("admin")) {
    await m.users.create({ id: "admin", name: "Administrador", password: "1234", tenantId: 1 });
  }
  let role = await m.roles.findOne({ where: { role: "tenant-demo" } });
  if (!role) role = await m.roles.create({ role: "tenant-demo" });
  const roleId = role.get("id");
  if (!await m.usersRoles.findOne({ where: { userId: "demo", roleId } })) {
    await m.usersRoles.create({ userId: "demo", roleId });
  }
  for (const tenantId of [1, 2]) {
    if (!await m.usersTenants.findOne({ where: { userId: "demo", tenantId } })) {
      await m.usersTenants.create({ userId: "demo", tenantId });
    }
    if (!await m.usersTenants.findOne({ where: { userId: "admin", tenantId } })) {
      await m.usersTenants.create({ userId: "admin", tenantId });
    }
  }
  if (!await m.usersRoles.findOne({ where: { userId: "admin", roleId } })) {
    await m.usersRoles.create({ userId: "admin", roleId });
  }
  const permissions = new Set(api.routes.getAll().flatMap(route => route.permissions || []));
  for (const permission of permissions) {
    let record = await m.permissions.findOne({ where: { permission } });
    if (!record) record = await m.permissions.create({ permission });
    const permissionId = record.get("id");
    if (!await m.rolesPermissions.findOne({ where: { roleId, permissionId } })) {
      await m.rolesPermissions.create({ roleId, permissionId });
    }
  }
  let adminRole = await m.roles.findOne({ where: { role: "tenant-admin" } });
  if (!adminRole) adminRole = await m.roles.create({ role: "tenant-admin" });
  const adminRoleId = adminRole.get("id");
  if (!await m.usersRoles.findOne({ where: { userId: "admin", roleId: adminRoleId } })) {
    await m.usersRoles.create({ userId: "admin", roleId: adminRoleId });
  }
  let manage = await m.permissions.findOne({ where: { permission: "tenants.manage" } });
  if (!manage) manage = await m.permissions.create({ permission: "tenants.manage" });
  if (!await m.rolesPermissions.findOne({ where: { roleId: adminRoleId, permissionId: manage.get("id") } })) {
    await m.rolesPermissions.create({ roleId: adminRoleId, permissionId: manage.get("id") });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start().then(example => {
    console.log(`Tenants: ${example.url} — usuario demo / clave 1234`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
      example.close().catch(console.error);
    });
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
