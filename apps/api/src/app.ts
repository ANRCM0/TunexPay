import { Prisma } from "@prisma/client";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import type { AppEnv } from "./types.js";
import { AppError } from "./lib/errors.js";
import { log } from "./lib/logger.js";
import { requestContext } from "./middleware/request-context.js";
import { adminRoutes } from "./routes/admin.js";
import { channelRoutes } from "./routes/channels.js";
import { epayRoutes } from "./routes/epay.js";
import { nativeRoutes } from "./routes/native.js";

export const app = new Hono<AppEnv>();
app.use("*", secureHeaders());
app.use("*", cors({ origin: [], allowHeaders: ["content-type", "authorization", "x-api-key", "x-app-id", "idempotency-key", "x-request-id"], allowMethods: ["GET", "POST", "OPTIONS"] }));
app.use("*", requestContext);

app.get("/health", (c) => c.json({ status: "ok", service: "tuoxin-pay-api", version: "0.1.0" }));
app.route("/api/v1", nativeRoutes);
app.route("/api/v1/channels", channelRoutes);
app.route("/admin/v1", adminRoutes);
app.route("/", epayRoutes);

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "接口不存在", requestId: c.get("requestId") } }, 404));

app.onError((error, c) => {
  const requestId = c.get("requestId");
  if (error instanceof AppError) {
    log(error.status >= 500 ? "error" : "warn", "request.failed", { requestId, code: error.code, message: error.message });
    return c.json({ error: { code: error.code, message: error.message, details: error.details, requestId } }, error.status as ContentfulStatusCode);
  }
  if (error instanceof ZodError) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "请求参数不合法", details: error.issues, requestId } }, 422);
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return c.json({ error: { code: "UNIQUE_CONFLICT", message: "资源已存在", requestId } }, 409);
  }
  log("error", "request.unhandled_error", { requestId, error: error instanceof Error ? error.stack : String(error) });
  return c.json({ error: { code: "INTERNAL_ERROR", message: "服务内部错误", requestId } }, 500);
});
