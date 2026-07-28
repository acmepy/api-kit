import { Model } from "seq";
import { getContext } from "../context/request-context.js";

export class BaseModel extends Model {
  static define(_seq) {
    throw new Error(`${this.name} must implement static define(seq)`);
  }

  getContext() {
    return getContext();
  }

  toJSON() {
    const data = this.get();
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== "function" && typeof value !== "symbol") {
        result[key] = value;
      }
    }
    return result;
  }
}
