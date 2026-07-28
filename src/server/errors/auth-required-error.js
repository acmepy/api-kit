import { AppError } from "./app-error.js";

export class AuthRequiredError extends AppError {
  constructor(message = "Autenticacion requerida", { cause = null, headers = null } = {}) {
    super(message, { status: 401, code: "AUTH_REQUIRED", cause });
    this.headers = headers;
  }
}
