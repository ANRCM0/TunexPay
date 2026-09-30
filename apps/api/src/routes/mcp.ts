import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { jsonSafe } from "../lib/json.js";
import { loadDashboardStats } from "../lib/dashboard-stats.js";
import { collectSystemStatus } from "../lib/system-status.js";

type RpcId = string | number | null;
type RpcRequest = { jsonrpc?: string; id?: RpcId; method?: string; params?: unknown };

const CURRENT_PROTOCOL = "2026-07-28";
const SUPPORTED_PROTOCOLS = new Set([CURRENT_PROTOCOL, "2025-11-25", "2025-06-18", "2025-03-26"]);

const statusValues = ["CREATED", "PENDING", "SUCCESS", "CLOSED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;
const paymentStatusValues = ["CREATED", "PROCESSING", "SUCCESS", "FAILED", "UNKNOWN", "CLOSED"] as const;
const exceptionStatusValues = ["OPEN", "PROCESSING", "RESOLVED", "IGNORED"] as const;

const toolDefinitions = [
  { name: "tunexpay_system_status", description: "Read API, MySQL, Redis, Worker and queue health without secrets.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "tunexpay_dashboard", description: "Read today's payment dashboard summary.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "tunexpay_list_applications", description: "List active TuneXPay business applications.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: "tunexpay_list_orders", description: "List recent orders, optionally filtered by order status.", inputSchema: { type: "object", properties: { status: { type: "string", enum: statusValues }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: "tunexpay_get_order", description: "Read one order and its payment/refund/event history by order number.", inputSchema: { type: "object", properties: { orderNo: { type: "string", minLength: 1, maxLength: 40 } }, required: ["orderNo"], additionalProperties: false } },
  { name: "tunexpay_list_payments", description: "List recent payment attempts, optionally filtered by payment status.", inputSchema: { type: "object", properties: { status: { type: "string", enum: paymentStatusValues }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: "tunexpay_list_refunds", description: "List recent refunds.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: "tunexpay_list_exceptions", description: "List payment exceptions, optionally filtered by workflow status.", inputSchema: { type: "object", properties: { status: { type: "string", enum: exceptionStatusValues }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: "tunexpay_list_channels", description: "List payment channel instances and verification state; credentials are never returned.", inputSchema: { type: "object", properties: { includeArchived: { type: "boolean" } }, additionalProperties: false } },
  { name: "tunexpay_list_notifications", description: "List recent administrator notification deliveries and plugin instance names.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } },
] as const;

function result(id: RpcId, value: unknown) {
  return { jsonrpc: "2.0" as const, id, result: value };
}

function error(id: RpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function textResult(value: unknown) {
  const safe = jsonSafe(value);
  return { content: [{ type: "text", text: JSON.stringify(safe, null, 2) }], structuredContent: safe };
}

function argsOf(params: unknown): { name: string; arguments: unknown } {
  const parsed = z.object({ name: z.string(), arguments: z.unknown().optional() }).parse(params);
  return { name: parsed.name, arguments: parsed.arguments ?? {} };
}

function limitOf(value: unknown) {
  return z.coerce.number().int().min(1).max(50).default(25).parse(value);
}

async function callTool(name: string, raw: unknown) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (name === "tunexpay_system_status") return textResult(await collectSystemStatus());
  if (name === "tunexpay_dashboard") {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return textResult(await loadDashboardStats(start));
  }
  if (name === "tunexpay_list_applications") {
    const limit = limitOf(input.limit);
    return textResult(await db.application.findMany({
      where: { archivedAt: null, appId: { not: "channel-diagnostics" } },
      select: { appId: true, name: true, status: true, defaultChannel: true, defaultChannelId: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "desc" }, take: limit,
    }));
  }
  if (name === "tunexpay_list_orders") {
    const limit = limitOf(input.limit);
    const status = z.enum(statusValues).optional().parse(input.status);
    return textResult(await db.order.findMany({
      where: { deletedAt: null, ...(status ? { status } : {}) },
      select: { orderNo: true, externalOrderNo: true, amount: true, currency: true, subject: true, status: true, paidAt: true, expiresAt: true, createdAt: true, application: { select: { appId: true, name: true } }, payments: { orderBy: { attemptNo: "desc" }, take: 1, select: { paymentNo: true, channel: true, status: true, paidAt: true } } },
      orderBy: { createdAt: "desc" }, take: limit,
    }));
  }
  if (name === "tunexpay_get_order") {
    const { orderNo } = z.object({ orderNo: z.string().min(1).max(40) }).parse(input);
    const row = await db.order.findUnique({
      where: { orderNo },
      include: {
        application: { select: { appId: true, name: true, archivedAt: true } },
        payments: { include: { refunds: true }, orderBy: { attemptNo: "asc" } },
        events: { orderBy: { id: "asc" } },
        webhookDeliveries: { select: { id: true, eventType: true, status: true, attempts: true, responseStatus: true, deliveredAt: true, createdAt: true }, orderBy: { createdAt: "asc" } },
        paymentExceptions: { orderBy: { detectedAt: "desc" } },
      },
    });
    if (!row) throw new Error("ORDER_NOT_FOUND");
    return textResult(row);
  }
  if (name === "tunexpay_list_payments") {
    const limit = limitOf(input.limit);
    const status = z.enum(paymentStatusValues).optional().parse(input.status);
    return textResult(await db.payment.findMany({
      where: status ? { status } : {},
      select: { paymentNo: true, status: true, channel: true, channelId: true, amount: true, receivedAmount: true, channelTradeNo: true, paidAt: true, createdAt: true, order: { select: { orderNo: true, externalOrderNo: true, subject: true, deletedAt: true, application: { select: { appId: true, name: true } } } } },
      orderBy: { createdAt: "desc" }, take: limit,
    }));
  }
  if (name === "tunexpay_list_refunds") {
    const limit = limitOf(input.limit);
    return textResult(await db.refund.findMany({
      select: { refundNo: true, externalRefundNo: true, amount: true, status: true, channelRefundNo: true, succeededAt: true, createdAt: true, application: { select: { appId: true, name: true, archivedAt: true } }, payment: { select: { paymentNo: true, order: { select: { orderNo: true, subject: true } } } } },
      orderBy: { createdAt: "desc" }, take: limit,
    }));
  }
  if (name === "tunexpay_list_exceptions") {
    const limit = limitOf(input.limit);
    const status = z.enum(exceptionStatusValues).optional().parse(input.status);
    return textResult(await db.paymentException.findMany({
      where: { ...(status ? { status } : {}), OR: [{ order: { deletedAt: null } }, { order: null }] },
      include: { order: { select: { orderNo: true, subject: true } }, payment: { select: { paymentNo: true, amount: true, receivedAmount: true, channelTradeNo: true } } },
      orderBy: [{ status: "asc" }, { severity: "desc" }, { detectedAt: "desc" }], take: limit,
    }));
  }
  if (name === "tunexpay_list_channels") {
    const includeArchived = z.boolean().default(false).parse(input.includeArchived);
    return textResult(await db.channelInstance.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      select: { id: true, plugin: true, name: true, enabled: true, revision: true, checkStatus: true, checkMessage: true, checkedAt: true, archivedAt: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
    }));
  }
  if (name === "tunexpay_list_notifications") {
    const limit = limitOf(input.limit);
    return textResult(await db.ownerNotificationDelivery.findMany({
      select: { id: true, eventType: true, title: true, status: true, attempts: true, lastError: true, createdAt: true, updatedAt: true, instance: { select: { id: true, name: true, plugin: true } } },
      orderBy: { createdAt: "desc" }, take: limit,
    }));
  }
  throw new Error("TOOL_NOT_FOUND");
}

export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.get("/", c => c.json({ error: "MCP uses authenticated Streamable HTTP POST requests." }, 405, { Allow: "POST" }));

mcpRoutes.post("/", async c => {
  const cfg = config();
  if (!cfg.MCP_ENABLED) return c.json({ error: "Not found" }, 404);
  const auth = c.req.header("authorization");
  if (!cfg.MCP_TOKEN || auth !== `Bearer ${cfg.MCP_TOKEN}`) return c.json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });

  let request: RpcRequest;
  try { request = await c.req.json<RpcRequest>(); }
  catch { return c.json(error(null, -32700, "Parse error"), 400); }

  const id = request.id ?? null;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return c.json(error(id, -32600, "Invalid Request"), 400);

  if (request.method === "notifications/initialized") return c.body(null, 202);
  if (request.method === "ping") return c.json(result(id, {}), 200, { "MCP-Protocol-Version": CURRENT_PROTOCOL, "Cache-Control": "no-store" });
  if (request.method === "initialize") {
    const requested = z.object({ protocolVersion: z.string().optional() }).passthrough().safeParse(request.params);
    const requestedVersion = requested.success ? requested.data.protocolVersion : undefined;
    const protocolVersion = requestedVersion && SUPPORTED_PROTOCOLS.has(requestedVersion) ? requestedVersion : CURRENT_PROTOCOL;
    return c.json(result(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "TuneXPay", version: "0.1.0" },
      instructions: "Read-only payment operations MCP. It cannot mutate orders, payments, refunds, channels, credentials, or notification configuration.",
    }), 200, { "MCP-Protocol-Version": protocolVersion, "Cache-Control": "no-store" });
  }
  if (request.method === "tools/list") {
    return c.json(result(id, { tools: toolDefinitions }), 200, { "MCP-Protocol-Version": CURRENT_PROTOCOL, "Cache-Control": "no-store" });
  }
  if (request.method === "tools/call") {
    try {
      const call = argsOf(request.params);
      const output = await callTool(call.name, call.arguments);
      return c.json(result(id, output), 200, { "MCP-Protocol-Version": CURRENT_PROTOCOL, "Cache-Control": "no-store" });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "TOOL_FAILED";
      return c.json(result(id, { isError: true, content: [{ type: "text", text: message }] }), 200, { "MCP-Protocol-Version": CURRENT_PROTOCOL, "Cache-Control": "no-store" });
    }
  }
  return c.json(error(id, -32601, "Method not found"), 404, { "MCP-Protocol-Version": CURRENT_PROTOCOL, "Cache-Control": "no-store" });
});
