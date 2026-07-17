import { AppError } from "./app-error.js";

export class AuthRequiredError extends AppError {
  constructor(message = "Autenticación requerida", { cause = null } = {}) {
    super(message, { status: 401, code: "AUTH_REQUIRED", cause });
  }
}
