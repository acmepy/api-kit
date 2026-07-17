import { AppError } from "./app-error.js";

export class InternalError extends AppError {
  constructor(message = "Error interno", { cause = null } = {}) {
    super(message, { status: 500, code: "INTERNAL_ERROR", cause });
  }
}
