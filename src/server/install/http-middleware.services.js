import express from "express";
import { normalizeMiddlewareOptions, normalizeTextOptions } from "../utils/normalize.js";

export async function installHttpMiddleware(router, config) {
  if (config.trustProxy !== false && config.trustProxy !== undefined) {
    router.use((req, _res, next) => {
      req.app.set("trust proxy", config.trustProxy);
      next();
    });
  }

  const corsOptions = normalizeMiddlewareOptions(config.cors);
  if (corsOptions) {
    const { default: cors } = await import("cors");
    router.use(cors(corsOptions === true ? undefined : corsOptions));
  }

  const helmetOptions = normalizeMiddlewareOptions(config.helmet);
  if (helmetOptions) {
    const { default: helmet } = await import("helmet");
    router.use(helmet(helmetOptions === true ? undefined : helmetOptions));
  }

  const compressionOptions = normalizeMiddlewareOptions(config.compression);
  if (compressionOptions) {
    const { default: compression } = await import("compression");
    router.use(compression(compressionOptions === true ? undefined : compressionOptions));
  }

  const rateLimitOptions = normalizeMiddlewareOptions(config.rateLimit);
  if (rateLimitOptions) {
    const { rateLimit } = await import("express-rate-limit");
    router.use(rateLimit(rateLimitOptions === true ? undefined : rateLimitOptions));
  }

  const jsonOptions = normalizeMiddlewareOptions(config.json);
  if (jsonOptions) router.use(express.json(jsonOptions === true ? undefined : jsonOptions));

  const textOptions = normalizeTextOptions(config.text);
  if (textOptions) router.use(express.text(textOptions));
}
