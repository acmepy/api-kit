import express from "express";
import { can } from "iam/express";
import { DataTypes } from "seq";
import { AppError, getContext } from "api/server";

// SQLite in this example uses one connection. Serialize transactions in this process.
const queues = new WeakMap();
export function transaction(seq, execute) {
  const previous = queues.get(seq) || Promise.resolve();
  const task = previous.then(() => seq.transaction(execute));
  queues.set(seq, task.catch(() => {}));
  return task;
}

export function definePlans(seq) {
  return seq.define("TenantPlan", {
    tenantId: { type: DataTypes.INTEGER, primaryKey: true },
    maxFacturas: { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: "tenant_plans", timestamps: false, tenant: false });
}

function limit(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError("El límite debe ser un entero mayor o igual a cero", { status: 400, code: "INVALID_INVOICE_LIMIT" });
  }
  return value;
}

export function installAdministration(api, plans) {
  const router = express.Router();
  const models = api.auth.models;
  router.use(api.auth.middleware, can("tenants.manage"));
  const count = async (tenantId, tx) => {
    // Only this authorized administration endpoint can inspect another tenant.
    const context = getContext();
    const original = context.tenantId;
    try {
      context.tenantId = tenantId;
      return await api.services.get("facturas").model.count({ transaction: tx });
    } finally { context.tenantId = original; }
  };
  api.router.get("/api/tenant-plan", api.auth.middleware, async (_req, res) => {
    const tenantId = getContext().tenantId;
    const plan = await plans.findByPk(tenantId);
    res.json({ ok: true, data: { tenantId, maxFacturas: plan?.get("maxFacturas") ?? null, facturas: await count(tenantId) } });
  });
  router.get("/", async (_req, res) => {
    const data = [];
    for (const tenant of await models.tenants.findAll()) {
      const row = tenant.toJSON();
      const plan = await plans.findByPk(row.id);
      data.push({ ...row, maxFacturas: plan?.get("maxFacturas") ?? null, facturas: await count(row.id) });
    }
    res.json({ ok: true, data });
  });
  router.post("/", async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 100) throw new AppError("El nombre es obligatorio y admite hasta 100 caracteres", { status: 400, code: "INVALID_TENANT_NAME" });
    const maxFacturas = limit(req.body.maxFacturas);
    const data = await transaction(api.auth.seq, async tx => {
      const tenant = await models.tenants.create({ name }, { transaction: tx });
      const tenantId = tenant.get("id");
      await plans.create({ tenantId, maxFacturas }, { transaction: tx });
      // Explicit demo assignment: the operator demo and the creator can enter the new tenant.
      const userIds = new Set(["demo", req.session.user.id]);
      for (const userId of userIds) await models.usersTenants.create({ userId, tenantId }, { transaction: tx });
      return { ...tenant.toJSON(), maxFacturas, facturas: 0 };
    });
    res.json({ ok: true, data });
  });
  router.patch("/:id/limit", async (req, res) => {
    const tenantId = Number(req.params.id);
    const maxFacturas = limit(req.body?.maxFacturas);
    const data = await transaction(api.auth.seq, async tx => {
      if (!await models.tenants.findByPk(tenantId, { transaction: tx })) {
        throw new AppError("Tenant no encontrado", { status: 404, code: "TENANT_NOT_FOUND" });
      }
      const existing = await plans.findByPk(tenantId, { transaction: tx });
      if (existing) await plans.update({ maxFacturas }, { where: { tenantId }, transaction: tx });
      else await plans.create({ tenantId, maxFacturas }, { transaction: tx });
      return { tenantId, maxFacturas, facturas: await count(tenantId, tx) };
    });
    res.json({ ok: true, data });
  });
  api.router.use("/api/admin/tenants", router);
}
