import { AppError } from "./app-error.js";

export class ForbiddenError extends AppError {
  constructor(message = "Acceso denegado", { cause = null } = {}) {
    super(message, { status: 403, code: "FORBIDDEN", cause });
  }
}
