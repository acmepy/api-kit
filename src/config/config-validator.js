import { ConfigError } from "../errors/config-error.js";

export function validateConfig(config) {
  const errors = {};

  if (!config.seq)  errors.seq = "seq instance is required";
  if (!config.baseDir) errors.baseDir = "baseDir is required";
  if (Object.keys(errors).length > 0) throw new ConfigError("Configuración inválida", { errors });
  return true;
}

export function validateModuleConfig(config) {
  const errors = {};
  if (!config.name)  errors.name = "Module name is required";
  if (Object.keys(errors).length > 0)  throw new ConfigError("Module config inválido", { errors });
  return true;
}
