export class AppError extends Error {
  constructor(message, { status = 500, code = "INTERNAL_ERROR", errors = null, cause = null } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.errors = errors;
    this.isOperational = true;
  }

  toJSON() {
    return { ok: false, code: this.code, message: this.message, ...(this.errors && { errors: this.errors })};
  }
}
