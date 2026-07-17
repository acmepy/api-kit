import { AppError } from "./app-error.js";

export class ConfigError extends AppError {
  constructor(message, { errors = null, cause = null } = {}) {
    super(message, { status: 500, code: "CONFIG_ERROR", errors, cause });
  }
}
