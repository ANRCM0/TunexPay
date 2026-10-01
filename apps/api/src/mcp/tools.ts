import { z } from "zod";
import { db } from "../db.js";
import { jsonSafe } from "../lib/json.js";
import { loadDashboardStats } from "../lib/dashboard-stats.js";
import { collectSystemStatus } from "../lib/system-status.js";
import { checkChannel } from "../services/channel-instance-service.js";
import { retryNotificationDelivery, setNotificationInstanceEnabled } from "../services/notification-instance-service.js";
import { queryPayment } from "../services/payment-service.js";
import { queryRefund } from "../services/refund-service.js";
import { requestAgentAction } from "../services/agent-approval-service.js";
import { AppError } from "../lib/errors.js";

export type ToolScope = "READ" | "OPERATE" | "FINANCIAL";
export type ToolContext = { scope: ToolScope; actor: string };

type Definition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scope: ToolScope;
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
};

const rank: Record<ToolScope, number> = { READ: 0, OPERATE: 1, FINANCIAL: 2 };
const orderStatuses = ["CREATED", "PENDING", "SUCCESS", "CLOSED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;
const paymentStatuses = ["CREATED", "PROCESSING", "SUCCESS", "FAILED", "UNKNOWN", "CLOSED"] as const;
const exceptionStatuses = ["OPEN", "PROCESSING", "RESOLVED", "IGNORED"] as const;
const limitOf = (value: unknown) => z.coerce.number().int().min(1).max(50).default(25).parse(value);

const tools: Definition[] = [
  {
    name: "tunexpay_system_status", scope: "READ",
    description: "Read API, MySQL, Redis, Worker and queue health without secrets.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => collectSystemStatus(),
  },
  {
    name: "tunexpay_dashboard", scope: "READ",
    description: "Read today's payment dashboard summary.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => { const start = new Date(); start.setHours(0,0,0,0); return loadDashboardStats(start); },
  },
  {
    name: "tunexpay_list_applications", scope: "READ",
    description: "List active TuneXPay business applications.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: async input => db.application.findMany({ where: { archivedAt: null, appId: { not: "channel-diagnostics" } }, select: { appId: true, name: true, status: true, defaultChannel: true, defaultChannelId: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: "desc" }, take: limitOf(input.limit) }),
  },
  {
    name: "tunexpay_list_orders", scope: "READ",
    description: "List recent orders, optionally filtered by order status.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: orderStatuses }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: async input => {
      const status = z.enum(orderStatuses).optional().parse(input.status);
      return db.order.findMany({ where: { deletedAt: null, ...(status ? { status } : {}) }, select: { orderNo: true, externalOrderNo: true, amount: true, currency: true, subject: true, status: true, paidAt: true, expiresAt: true, createdAt: true, application: { select: { appId: true, name: true } }, payments: { orderBy: { attemptNo: "desc" }, take: 1, select: { paymentNo: true, channel: true, status: true, paidAt: true } } }, orderBy: { createdAt: "desc" }, take: limitOf(input.limit) });
    },
  },
  {
    name: "tunexpay_get_order", scope: "READ",
    description: "Read one order and its payment/refund/event history by order number.",
    inputSchema: { type: "object", properties: { orderNo: { type: "string", minLength: 1, maxLength: 40 } }, required: ["orderNo"], additionalProperties: false },
    execute: async input => {
      const orderNo = z.string().min(1).max(40).parse(input.orderNo);
      const row = await db.order.findUnique({ where: { orderNo }, include: { application: { select: { appId: true, name: true, archivedAt: true } }, payments: { include: { refunds: true }, orderBy: { attemptNo: "asc" } }, events: { orderBy: { id: "asc" } }, webhookDeliveries: { select: { id: true, eventType: true, status: true, attempts: true, responseStatus: true, deliveredAt: true, createdAt: true }, orderBy: { createdAt: "asc" } }, paymentExceptions: { orderBy: { detectedAt: "desc" } } } });
      if (!row) throw new AppError("ORDER_NOT_FOUND","订单不存在",404);
      return row;
    },
  },
  {
    name: "tunexpay_list_payments", scope: "READ",
    description: "List recent payment attempts, optionally filtered by payment status.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: paymentStatuses }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: async input => {
      const status = z.enum(paymentStatuses).optional().parse(input.status);
      return db.payment.findMany({ where: status ? { status } : {}, select: { paymentNo: true, status: true, channel: true, channelId: true, amount: true, receivedAmount: true, channelTradeNo: true, paidAt: true, createdAt: true, order: { select: { orderNo: true, externalOrderNo: true, subject: true, deletedAt: true, application: { select: { appId: true, name: true } } } } }, orderBy: { createdAt: "desc" }, take: limitOf(input.limit) });
    },
  },
  {
    name: "tunexpay_list_refunds", scope: "READ",
    description: "List recent refunds.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: async input => db.refund.findMany({ select: { refundNo: true, externalRefundNo: true, amount: true, status: true, channelRefundNo: true, succeededAt: true, createdAt: true, application: { select: { appId: true, name: true, archivedAt: true } }, payment: { select: { paymentNo: true, order: { select: { orderNo: true, subject: true } } } } }, orderBy: { createdAt: "desc" }, take: limitOf(input.limit) }),
  },
  {
    name: "tunexpay_list_exceptions", scope: "READ",
    description: "List payment exceptions, optionally filtered by workflow status.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: exceptionStatuses }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: async input => {
      const status = z.enum(exceptionStatuses).optional().parse(input.status);
      return db.paymentException.findMany({ where: { ...(status ? { status } : {}), OR: [{ order: { deletedAt: null } }, { order: null }] }, include: { order: { select: { orderNo: true, subject: true } }, payment: { select: { paymentNo: true, amount: true, receivedAmount: true, channelTradeNo: true } } }, orderBy: [{ status: "asc" }, { severity: "desc" }, { detectedAt: "desc" }], take: limitOf(input.limit) });
    },
  },
  {
    name: "tunexpay_list_channels", scope: "READ",
    description: "List payment channel instances and verification state; credentials are never returned.",
    inputSchema: { type: "object", properties: { includeArchived: { type: "boolean" } }, additionalProperties: false },
    execute: async input => db.channelInstance.findMany({ where: z.boolean().default(false).parse(input.includeArchived) ? {} : { archivedAt: null }, select: { id: true, plugin: true, name: true, enabled: true, revision: true, checkStatus: true, checkMessage: true, checkedAt: true, archivedAt: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: "asc" } }),
  },
  {
    name: "tunexpay_list_notifications", scope: "READ",
    description: "List recent administrator notification deliveries and plugin instance names.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: async input => db.ownerNotificationDelivery.findMany({ select: { id: true, eventType: true, title: true, status: true, attempts: true, lastError: true, createdAt: true, updatedAt: true, instance: { select: { id: true, name: true, plugin: true } } }, orderBy: { createdAt: "desc" }, take: limitOf(input.limit) }),
  },
  {
    name: "tunexpay_list_agent_approvals", scope: "READ",
    description: "List recent human-approval requests created by agents or MCP clients.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: async input => db.agentActionApproval.findMany({ select: { id: true, action: true, summary: true, requestedBy: true, status: true, expiresAt: true, approvedAt: true, rejectedAt: true, executedAt: true, lastError: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: limitOf(input.limit) }),
  },
  {
    name: "tunexpay_retry_business_webhook", scope: "OPERATE",
    description: "Retry one failed business Webhook delivery. Does not alter payment facts.",
    inputSchema: { type: "object", properties: { deliveryId: { type: "string" } }, required: ["deliveryId"], additionalProperties: false },
    execute: async input => {
      const id = z.string().min(1).max(191).parse(input.deliveryId);
      const row = await db.webhookDelivery.findUnique({ where: { id } });
      if (!row) throw new AppError("WEBHOOK_NOT_FOUND","业务 Webhook 投递不存在",404);
      if (row.status === "SUCCESS") throw new AppError("WEBHOOK_ALREADY_SUCCESS","已成功投递无需重试",409);
      return db.webhookDelivery.update({ where: { id }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lockedUntil: null, lastError: null } });
    },
  },
  {
    name: "tunexpay_retry_notification", scope: "OPERATE",
    description: "Retry one administrator notification delivery.",
    inputSchema: { type: "object", properties: { deliveryId: { type: "string" } }, required: ["deliveryId"], additionalProperties: false },
    execute: async input => retryNotificationDelivery(z.string().min(1).max(191).parse(input.deliveryId)),
  },
  {
    name: "tunexpay_check_channel", scope: "OPERATE",
    description: "Run the existing connection/permission check for a payment channel.",
    inputSchema: { type: "object", properties: { channelId: { type: "string" } }, required: ["channelId"], additionalProperties: false },
    execute: async input => {
      const id = z.string().min(1).max(80).parse(input.channelId);
      const row = await db.channelInstance.findUnique({ where: { id }, select: { revision: true } });
      if (!row) throw new AppError("CHANNEL_NOT_FOUND","通道不存在",404);
      return checkChannel(id, row.revision);
    },
  },
  {
    name: "tunexpay_query_payment", scope: "OPERATE",
    description: "Actively query a payment at the configured provider. The normal state machine remains authoritative.",
    inputSchema: { type: "object", properties: { paymentNo: { type: "string" } }, required: ["paymentNo"], additionalProperties: false },
    execute: async input => queryPayment(null, z.string().min(1).max(40).parse(input.paymentNo)),
  },
  {
    name: "tunexpay_query_refund", scope: "OPERATE",
    description: "Actively query a refund at the configured provider.",
    inputSchema: { type: "object", properties: { refundNo: { type: "string" } }, required: ["refundNo"], additionalProperties: false },
    execute: async input => queryRefund(null, z.string().min(1).max(40).parse(input.refundNo)),
  },
  {
    name: "tunexpay_set_notification_enabled", scope: "OPERATE",
    description: "Enable or disable one administrator notification instance.",
    inputSchema: { type: "object", properties: { instanceId: { type: "string" }, enabled: { type: "boolean" } }, required: ["instanceId","enabled"], additionalProperties: false },
    execute: async input => setNotificationInstanceEnabled(z.string().min(1).max(80).parse(input.instanceId), z.boolean().parse(input.enabled)),
  },
  {
    name: "tunexpay_request_payment_close", scope: "FINANCIAL",
    description: "Create a 15-minute human approval request to close an unpaid payment. This never closes it directly.",
    inputSchema: { type: "object", properties: { paymentNo: { type: "string" }, reason: { type: "string" } }, required: ["paymentNo","reason"], additionalProperties: false },
    execute: async (input, context) => requestAgentAction("CLOSE_PAYMENT", input, context.actor),
  },
  {
    name: "tunexpay_request_refund", scope: "FINANCIAL",
    description: "Create a 15-minute human approval request for a refund. This never moves money directly.",
    inputSchema: { type: "object", properties: { paymentNo: { type: "string" }, amount: { type: "integer", minimum: 1 }, reason: { type: "string" } }, required: ["paymentNo","amount","reason"], additionalProperties: false },
    execute: async (input, context) => requestAgentAction("CREATE_REFUND", input, context.actor),
  },
  {
    name: "tunexpay_request_exception_resolution", scope: "FINANCIAL",
    description: "Create a human approval request to resolve or ignore a payment exception.",
    inputSchema: { type: "object", properties: { exceptionId: { type: "string" }, status: { type: "string", enum: ["RESOLVED","IGNORED"] }, resolution: { type: "string" }, resolutionRef: { type: "string" } }, required: ["exceptionId","status","resolution"], additionalProperties: false },
    execute: async (input, context) => requestAgentAction("RESOLVE_EXCEPTION", input, context.actor),
  },
];

export function scopeAllows(scope: ToolScope, required: ToolScope) { return rank[scope] >= rank[required]; }

export function toolCatalog(scope: ToolScope) {
  return tools.filter(tool => scopeAllows(scope, tool.scope)).map(({ execute: _execute, scope: _scope, ...definition }) => definition);
}

export async function executeTool(name: string, raw: unknown, context: ToolContext) {
  const tool = tools.find(item => item.name === name);
  if (!tool) throw new AppError("MCP_TOOL_NOT_FOUND","工具不存在",404);
  if (!scopeAllows(context.scope, tool.scope)) throw new AppError("MCP_SCOPE_DENIED",`当前凭证没有 ${tool.scope} 权限`,403);
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return jsonSafe(await tool.execute(input, context));
}
