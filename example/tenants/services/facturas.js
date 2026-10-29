import { AppError, BaseService, getContext } from "api/server";
import { transaction } from "../administration.js";

export default class Facturas extends BaseService {
  async create(args = {}) {
    return transaction(this.seq, async tx => {
      const tenantId = getContext()?.tenantId;
      const plan = await this.seq.getModel("TenantPlan").findByPk(tenantId, { transaction: tx });
      if (!plan) throw new AppError("El tenant no tiene un límite configurado", { status: 409, code: "TENANT_PLAN_MISSING" });
      const maxFacturas = plan.get("maxFacturas");
      const current = await this.model.count({ transaction: tx });
      if (current >= maxFacturas) {
        throw new AppError(`Límite de ${maxFacturas} facturas alcanzado para este tenant`, {
          status: 409, code: "TENANT_INVOICE_LIMIT", errors: { maxFacturas, facturas: current },
        });
      }
      // Count, master, details and audit commit or roll back together.
      return super.create({ ...args, transaction: tx });
    });
  }
}
