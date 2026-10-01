import { Prisma } from "@prisma/client";
import type { MiddlewareHandler } from "hono";
import { ZodError } from "zod";
import { db } from "../db.js";
import { AppError } from "../lib/errors.js";
import { log } from "../lib/logger.js";
import type { AppEnv } from "../types.js";

type AuditDescriptor = { action: string; resourceType: string | null; resourceId: string | null };

/**
 * 把异常映射成审计里的状态与错误码。
 *
 * 与 `app.onError` 的映射保持一致；只在请求确实抛出了异常时使用（正常路径下审计的
 * HTTP 状态一律以 `c.res.status`——客户端实际收到的那个——为准）。
 */
function auditFailure(error: unknown): { statusCode: number; errorCode: string | null } {
  if (error instanceof AppError) return { statusCode: error.status, errorCode: error.code };
  if (error instanceof ZodError) return { statusCode: 422, errorCode: "VALIDATION_ERROR" };
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { statusCode: 409, errorCode: "UNIQUE_CONFLICT" };
  if (error instanceof Error) return { statusCode: 500, errorCode: "INTERNAL_ERROR" };
  return { statusCode: 500, errorCode: null };
}

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
    // 只有在本中间件之上的实现没有装 onError 时才会走到这里（见下面 finally 的说明）。
    ({ statusCode, errorCode } = auditFailure(error));
    throw error;
  } finally {
    // Hono 的 compose 在「更内层」的 dispatch 里就捕获了 handler 抛出的异常、交给
    // app.onError 转成响应，并把原始异常挂在同一个 context 上（context.error）。
    // 因此这里的 next() 通常不会抛错，业务失败表现为「status >= 400 但 catch 没跑」。
    // 不读 context.error，审计里的 errorCode 就会永远是 null。
    if (errorCode === null && !success) errorCode = auditFailure(c.error).errorCode;
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
  if (root === "routing-groups") return descriptor(operation === "delete" ? "ROUTING_GROUP_DELETE" : id ? "ROUTING_GROUP_UPDATE" : "ROUTING_GROUP_CREATE", "ROUTING_GROUP", id ?? null);
  if (root === "applications" && operation === "routing-group") return descriptor("APPLICATION_ROUTING_GROUP_CHANGE", "APPLICATION", id ?? null);
  if (root === "channel-instances") return descriptor(operation === "check" ? "CHANNEL_CHECK" : operation === "test-payment" ? "CHANNEL_TEST_PAYMENT" : id ? "CHANNEL_UPDATE" : "CHANNEL_CREATE", "CHANNEL", id ?? null);
  if (root === "notification-instances") {
    const action = !id ? "NOTIFICATION_INSTANCE_CREATE"
      : operation === "subscriptions" ? "NOTIFICATION_INSTANCE_SUBSCRIPTIONS"
      : operation === "test" ? "NOTIFICATION_INSTANCE_TEST"
      : operation === "delete" ? "NOTIFICATION_INSTANCE_DELETE"
      : "NOTIFICATION_INSTANCE_UPDATE";
    return descriptor(action, "NOTIFICATION_INSTANCE", id ?? null);
  }
  if (root === "notification-deliveries" && operation === "retry") return descriptor("NOTIFICATION_DELIVERY_RETRY", "NOTIFICATION_DELIVERY", id ?? null);
  if (root === "mcp" && id === "clients") {
    const clientId = segments[2] ?? null;
    const clientOperation = segments[3];
    if (!clientId && method === "POST") return descriptor("MCP_CLIENT_CREATE", "MCP_CLIENT", null);
    if (clientOperation === "rotate") return descriptor("MCP_CLIENT_TOKEN_ROTATE", "MCP_CLIENT", clientId);
    if (clientOperation === "enabled") return descriptor("MCP_CLIENT_STATUS_UPDATE", "MCP_CLIENT", clientId);
    return descriptor("MCP_CLIENT_UPDATE", "MCP_CLIENT", clientId);
  }
  if (root === "mcp" && id === "approvals") {
    const approvalId = segments[2] ?? null;
    const approvalOperation = segments[3];
    if (approvalOperation === "approve") return descriptor("MCP_ACTION_APPROVE", "MCP_ACTION", approvalId);
    if (approvalOperation === "reject") return descriptor("MCP_ACTION_REJECT", "MCP_ACTION", approvalId);
  }
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
  if (method === "POST" && root === "refunds" && !id) return descriptor("REFUND_CREATE", "REFUND", null);
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
