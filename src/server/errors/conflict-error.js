import { AppError } from "./app-error.js";

export class ConflictError extends AppError {
  constructor(message = "Conflicto", { cause = null } = {}) {
    super(message, { status: 409, code: "CONFLICT", cause });
  }
}
