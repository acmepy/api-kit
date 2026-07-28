import { AppError } from "./app-error.js";

export class NotFoundError extends AppError {
  constructor(resource = "Recurso", { cause = null } = {}) {
    super(`${resource} no encontrado`, { status: 404, code: "NOT_FOUND", cause });
  }
}
