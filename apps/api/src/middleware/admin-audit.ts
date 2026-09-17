import { Prisma } from "@prisma/client";
import type { MiddlewareHandler } from "hono";
import { ZodError } from "zod";
import { db } from "../db.js";
import { AppError } from "../lib/errors.js";
import { log } from "../lib/logger.js";
import type { AppEnv } from "../types.js";

type AuditDescriptor = { action: string; resourceType: string | null; resourceId: string | null };

export const adminAudit: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isMutation(c.req.method)) return next();
  let success = false;
  let statusCode = 500;
  let errorCode: string | null = null;
  try {
    await next();
    statusCode = c.res.status;
    success = statusCode < 400;
  } catch (error) {
    if (error instanceof AppError) {
      statusCode = error.status;
      errorCode = error.code;
    } else if (error instanceof ZodError) {
      statusCode = 422;
      errorCode = "VALIDATION_ERROR";
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      statusCode = 409;
      errorCode = "UNIQUE_CONFLICT";
    } else {
      statusCode = 500;
      errorCode = "INTERNAL_ERROR";
    }
    throw error;
  } finally {
    const descriptor = describeAdminAction(c.req.method, c.req.path);
    try {
      await db.adminAuditLog.create({ data: {
        actor: "admin-token",
        ...descriptor,
        method: c.req.method,
        path: c.req.path.slice(0, 255),
        requestId: c.get("requestId") || null,
        ipAddress: clientIp(c.req.header("cf-connecting-ip"), c.req.header("x-forwarded-for"), c.req.header("x-real-ip")),
        userAgent: c.req.header("user-agent")?.slice(0, 500) || null,
        success,
        statusCode,
        errorCode,
      } });
    } catch (auditError) {
      log("error", "admin_audit.write_failed", {
        requestId: c.get("requestId"),
        error: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
  }
};

export function describeAdminAction(method: string, path: string): AuditDescriptor {
  const segments = path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean);
  const [root, id, operation] = segments;
  if (root === "channel-instances") return descriptor(operation === "check" ? "CHANNEL_CHECK" : operation === "test-payment" ? "CHANNEL_TEST_PAYMENT" : id ? "CHANNEL_UPDATE" : "CHANNEL_CREATE", "CHANNEL", id ?? null);
  if (root === "applications" && operation === "channel-instance") return descriptor("APPLICATION_CHANNEL_CHANGE", "APPLICATION", id ?? null);
  if (method === "POST" && root === "applications" && !id) return descriptor("APPLICATION_CREATE", "APPLICATION", null);
  if (root === "applications" && operation === "rotate-api-key") return descriptor("APPLICATION_API_KEY_ROTATE", "APPLICATION", id ?? null);
  if (root === "applications" && operation === "rotate-credentials") return descriptor("APPLICATION_CREDENTIAL_ROTATE", "APPLICATION", id ?? null);
  if (root === "applications" && operation === "status") return descriptor("APPLICATION_STATUS_UPDATE", "APPLICATION", id ?? null);
  if (root === "applications" && operation === "delete") return descriptor("APPLICATION_DELETE", "APPLICATION", id ?? null);
  if (root === "applications" && operation === "archive") return descriptor("APPLICATION_ARCHIVE", "APPLICATION", id ?? null);
  if (root === "applications" && operation === "restore") return descriptor("APPLICATION_RESTORE", "APPLICATION", id ?? null);
  if (root === "applications" && operation === "default-channel") return descriptor("APPLICATION_CHANNEL_CHANGE", "APPLICATION", id ?? null);
  if (root === "channels" && id === "alipay" && operation === "check") return descriptor("ALIPAY_CONNECTION_CHECK", "CHANNEL", "ALIPAY");
  if (root === "channels" && id === "alipay-bill" && operation === "settings") return descriptor("ALIPAY_BILL_SETTINGS_UPDATE", "CHANNEL", "ALIPAY_BILL");
  if (root === "payments" && operation === "query") return descriptor("PAYMENT_QUERY", "PAYMENT", id ?? null);
  if (root === "payments" && operation === "close") return descriptor("PAYMENT_CLOSE", "PAYMENT", id ?? null);
  if (root === "refunds" && operation === "query") return descriptor("REFUND_QUERY", "REFUND", id ?? null);
  if (root === "exceptions" && operation === "status") return descriptor("PAYMENT_EXCEPTION_UPDATE", "PAYMENT_EXCEPTION", id ?? null);
  if (root === "webhooks" && operation === "retry") return descriptor("WEBHOOK_RETRY", "WEBHOOK", id ?? null);
  if (root === "reconciliation" && id === "alipay" && operation === "import") return descriptor("ALIPAY_BILL_IMPORT", "RECONCILIATION", null);
  if (root === "reconciliation" && id === "receipts" && segments[3] === "match") return descriptor("RECEIPT_REMATCH", "RECEIPT", segments[2] ?? null);
  return descriptor(`${method}_${segments.join("_").toUpperCase() || "ADMIN"}`, root?.toUpperCase() || null, id || null);
}

function descriptor(action: string, resourceType: string | null, resourceId: string | null): AuditDescriptor {
  return { action, resourceType, resourceId };
}

function isMutation(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

function clientIp(cf: string | undefined, forwarded: string | undefined, real: string | undefined): string | null {
  return (cf || forwarded?.split(",")[0] || real)?.trim().slice(0, 64) || null;
}
