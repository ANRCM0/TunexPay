import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";
import { generateId } from "../lib/crypto.js";
import { log } from "../lib/logger.js";

export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.req.header("x-request-id")?.slice(0, 64) || generateId("req");
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);
  const started = performance.now();
  await next();
  log("info", "request.completed", {
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
  });
};
