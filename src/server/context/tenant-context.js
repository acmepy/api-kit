import { AppError } from "../errors/app-error.js";
import { ConfigError } from "../errors/config-error.js";
import { getContext } from "./request-context.js";

export function normalizeTenantConfig(tenant) {
  if (tenant === undefined || tenant === false) return false;
  if (tenant === true) return { attribute: "tenantId", type: "integer" };
  if (!tenant || typeof tenant !== "object" || Array.isArray(tenant) || typeof tenant.attribute !== "string" || !tenant.attribute.trim()) {
    throw new ConfigError("tenant requiere un attribute valido");
  }
  return { type: "integer", ...tenant };
}

export function tenantAttribute(model) {
  return model?.options?.tenant?.attribute;
}

export function tenantValues(model, values) {
  const attribute = tenantAttribute(model);
  if (!attribute) return values;
  const tenantId = getContext()?.tenantId;
  if (tenantId === undefined || tenantId === null) {
    throw new AppError("Falta el tenant de la sesion autenticada", { status: 403, code: "TENANT_CONTEXT_MISSING" });
  }
  if (Object.hasOwn(values || {}, attribute) && values[attribute] !== tenantId) {
    throw new AppError("El tenant enviado no corresponde a la sesion", { status: 403, code: "TENANT_MISMATCH" });
  }
  return { ...values, [attribute]: tenantId };
}
