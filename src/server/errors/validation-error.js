import { AppError } from "./app-error.js";

export class ValidationError extends AppError {
  constructor(message = "Datos inválidos", { errors = null, cause = null } = {}) {
    super(message, { status: 400, code: "VALIDATION_ERROR", errors, cause });
  }
}
