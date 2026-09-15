export class ApiClientError extends Error {
  constructor(message, { status = 0, response = null } = {}) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.response = response;
    this.errors = response?.errors || null;
    this.code = response?.code || null;
  }
}
