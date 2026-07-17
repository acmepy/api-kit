import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

const storage = new AsyncLocalStorage();

export function runWithContext(req, res, next) {
  const txId = req.headers["x-transaction-id"] || crypto.randomUUID();
  const context = { txId };
  storage.run(context, () => {next()});
}

export function getContext() {
  return storage.getStore() || null;
}

export function setContextValue(key, value) {
  const ctx = getContext();
  if (ctx) ctx[key] = value;
}
