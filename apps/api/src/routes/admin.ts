import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { channelFor } from "../channels/registry.js";
import { config } from "../config.js";
import { billRuntimeConfig, getPublicBillSettings, saveBillSettings } from "../services/bill-settings-service.js";
import { getOwnerSettings, saveOwnerSettings, testOwnerNotification } from "../services/owner-notification-service.js";
import { db } from "../db.js";
import { jsonSafe } from "../lib/json.js";
import { AppError } from "../lib/errors.js";
import { RECOVERY_MAX_ATTEMPTS } from "../lib/recovery-policy.js";
import { adminAuth } from "../middleware/auth.js";
import { adminAudit } from "../middleware/admin-audit.js";
import { createApplication, rotateApplicationApiKey } from "../services/application-service.js";
import { closePayment, queryPayment } from "../services/payment-service.js";
import { updatePaymentException } from "../services/payment-exception-service.js";
import { queryRefund } from "../services/refund-service.js";
import { importAlipayBill, matchReceipt } from "../services/reconciliation-service.js";
import { collectSystemStatus } from "../lib/system-status.js";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", adminAuth);
adminRoutes.use("*", adminAudit);

adminRoutes.get("/owner-notifications/settings", async c => c.json({ data: await getOwnerSettings() }));
adminRoutes.post("/owner-notifications/settings", async c => c.json({ data: await saveOwnerSettings(await c.req.json()) }));
adminRoutes.post("/owner-notifications/test", async c => {
  const { channel } = z.object({ channel: z.enum(["EMAIL", "FEISHU"]) }).parse(await c.req.json());
  const task = await testOwnerNotification(channel);
  return c.json({ data: { id: task.id, status: task.status } }, 202);
});
adminRoutes.get("/owner-notifications/deliveries", async c => {
  const rows = await db.ownerNotificationDelivery.findMany({ orderBy: { createdAt: "desc" }, take: 50, select: { id: true, channel: true, title: true, status: true, attempts: true, lastError: true, createdAt: true } });
  return c.json({ data: rows });
});

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function pageOf(c: Context<AppEnv>) {
  const { page, pageSize } = paginationSchema.parse(c.req.query());
  return { page, pageSize, skip: (page - 1) * pageSize };
}

adminRoutes.get("/dashboard", async (c) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const [applications, ordersToday, successfulToday, unknownPayments, pendingWebhooks, amount, recoveringPayments, recoveringRefunds, exhaustedRecoveries, unmatchedReceipts, mismatchedReceipts, openPaymentExceptions, expirationFailures, failedAdminActionsToday] = await Promise.all([
    db.application.count({ where: { status: "ACTIVE" } }),
    db.order.count({ where: { createdAt: { gte: start } } }),
    db.order.count({ where: { paidAt: { gte: start } } }),
    db.payment.count({ where: { status: "UNKNOWN" } }),
    db.webhookDelivery.count({ where: { status: { in: ["PENDING", "PROCESSING", "DEAD"] } } }),
    db.payment.aggregate({ where: { status: "SUCCESS", paidAt: { gte: start } }, _sum: { amount: true } }),
    db.payment.count({ where: { channel: "ALIPAY", status: { in: ["PROCESSING", "UNKNOWN"] }, nextQueryAt: { not: null } } }),
    db.refund.count({ where: { payment: { channel: "ALIPAY" }, status: { in: ["PROCESSING", "UNKNOWN"] }, nextQueryAt: { not: null } } }),
    Promise.all([
      db.payment.count({ where: { channel: "ALIPAY", status: { in: ["PROCESSING", "UNKNOWN"] }, nextQueryAt: null, queryAttempts: { gte: RECOVERY_MAX_ATTEMPTS } } }),
      db.refund.count({ where: { payment: { channel: "ALIPAY" }, status: { in: ["PROCESSING", "UNKNOWN"] }, nextQueryAt: null, queryAttempts: { gte: RECOVERY_MAX_ATTEMPTS } } }),
    ]).then(([payments, refunds]) => payments + refunds),
    db.receipt.count({ where: { matchStatus: "UNMATCHED" } }),
    db.receipt.count({ where: { matchStatus: "MISMATCH" } }),
    db.paymentException.count({ where: { status: { in: ["OPEN", "PROCESSING"] } } }),
    db.order.count({ where: { status: { in: ["CREATED", "PENDING"] }, expirationError: { not: null } } }),
    db.adminAuditLog.count({ where: { success: false, createdAt: { gte: start } } }),
  ]);
  const recentEvents = await db.paymentEvent.findMany({ orderBy: { id: "desc" }, take: 12 });
  return c.json({ data: jsonSafe({
    applications, ordersToday, successfulToday, amountToday: amount._sum.amount ?? 0, unknownPayments, pendingWebhooks,
    recoveringPayments, recoveringRefunds, exhaustedRecoveries, unmatchedReceipts, mismatchedReceipts,
    openPaymentExceptions, expirationFailures, failedAdminActionsToday, recentEvents,
  }) });
});

adminRoutes.get("/system", async c => c.json({ data: jsonSafe(await collectSystemStatus()) }));

adminRoutes.get("/applications", async (c) => {
  const applications = await db.application.findMany({ orderBy: { createdAt: "desc" }, select: {
    id: true, appId: true, epayPid: true, name: true, status: true, webhookUrl: true, defaultChannel: true, createdAt: true, updatedAt: true,
  } });
  return c.json({ data: applications });
});

adminRoutes.get("/audits", async (c) => {
  const { page, pageSize, skip } = pageOf(c);
  const successQuery = z.enum(["true", "false"]).optional().parse(c.req.query("success"));
  const action = z.string().trim().max(80).optional().parse(c.req.query("action"));
  const where = {
    ...(successQuery ? { success: successQuery === "true" } : {}),
    ...(action ? { action } : {}),
  };
  const [rows, total] = await Promise.all([
    db.adminAuditLog.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip, take: pageSize }),
    db.adminAuditLog.count({ where }),
  ]);
  return c.json({ data: rows, meta: { page, pageSize, total } });
});

adminRoutes.post("/applications", async (c) => {
  const input = z.object({
    name: z.string().trim().min(1).max(120),
    webhookUrl: z.string().url().max(500).optional().or(z.literal("")),
    defaultChannel: z.enum(["ALIPAY", "ALIPAY_BILL", "MOCK"]).default("MOCK"),
  }).parse(await c.req.json());
  const result = await createApplication({ ...input, webhookUrl: input.webhookUrl || null });
  return c.json({ data: result }, 201);
});

adminRoutes.post("/applications/:id/rotate-api-key", async (c) => {
  return c.json({ data: await rotateApplicationApiKey(c.req.param("id")) });
});

adminRoutes.post("/applications/:id/default-channel", async (c) => {
  const channel = z.enum(["ALIPAY", "ALIPAY_BILL", "MOCK"]).parse((await c.req.json()).channel);
  const status = await channelStatus();
  if (channel === "ALIPAY" && !status.alipay.ready) throw new AppError("ALIPAY_NOT_CONFIGURED", "请先完整配置支付宝通道", 409);
  if (channel === "ALIPAY_BILL" && !status.alipayBill.ready) throw new AppError("ALIPAY_BILL_NOT_CONFIGURED", "请先完整配置支付宝账单收款通道", 409);
  if (channel === "MOCK" && !status.mock.ready) throw new AppError("MOCK_NOT_CONFIGURED", "Mock 通道当前未启用或缺少访问令牌", 409);
  const application = await db.application.findUnique({ where: { id: c.req.param("id") } });
  if (!application) throw new AppError("APPLICATION_NOT_FOUND", "应用不存在", 404);
  return c.json({ data: await db.application.update({ where: { id: application.id }, data: { defaultChannel: channel } }) });
});

adminRoutes.get("/channels", async (c) => c.json({ data: await channelStatus() }));
adminRoutes.get("/channels/alipay-bill/settings", async (c) => c.json({ data: await getPublicBillSettings() }));
adminRoutes.post("/channels/alipay-bill/settings", async (c) => c.json({ data: await saveBillSettings(await c.req.json()) }));
adminRoutes.get("/channels/alipay-bill/collector", async (c) => {
  const { alipayBillCollectorStatus } = await import("../services/alipay-bill-collector-service.js");
  return c.json({ data: await alipayBillCollectorStatus() });
});

adminRoutes.post("/channels/alipay/check", async (c) => {
  const status = await channelStatus();
  if (!status.alipay.ready) throw new AppError("ALIPAY_NOT_CONFIGURED", "支付宝 App ID、应用私钥或支付宝公钥尚未完整配置", 409);
  const result = await channelFor("ALIPAY").query(`txp_check_${Date.now()}`);
  return c.json({ data: { ok: true, channel: "ALIPAY", gatewayStatus: result.status, checkedAt: new Date().toISOString() } });
});

adminRoutes.get("/orders", async (c) => {
  const { page, pageSize, skip } = pageOf(c);
  const status = z.enum(["CREATED", "PENDING", "SUCCESS", "CLOSED", "PARTIALLY_REFUNDED", "REFUNDED"]).optional().parse(c.req.query("status"));
  const where = status ? { status } : {};
  const [rows, total] = await Promise.all([
    db.order.findMany({ where, include: { application: { select: { name: true, appId: true } }, payments: { orderBy: { attemptNo: "desc" }, take: 1 } }, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
    db.order.count({ where }),
  ]);
  return c.json({ data: rows, meta: { page, pageSize, total } });
});

adminRoutes.get("/orders/:orderNo", async (c) => {
  const orderNo = z.string().max(40).parse(c.req.param("orderNo"));
  const order = await db.order.findUnique({ where: { orderNo }, include: {
    application: { select: { name: true, appId: true } }, payments: { include: { refunds: true }, orderBy: { attemptNo: "desc" } }, events: { orderBy: { id: "asc" } }, webhookDeliveries: { orderBy: { createdAt: "asc" } }, paymentExceptions: { orderBy: { detectedAt: "desc" } },
  } });
  if (!order) throw new AppError("ORDER_NOT_FOUND", "订单不存在", 404);
  return c.json({ data: jsonSafe(order) });
});

adminRoutes.get("/refunds", async (c) => {
  const { page, pageSize, skip } = pageOf(c);
  const [rows, total] = await Promise.all([
    db.refund.findMany({ include: { application: { select: { name: true } }, payment: { select: { paymentNo: true, order: { select: { orderNo: true, subject: true } } } } }, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
    db.refund.count(),
  ]);
  return c.json({ data: rows, meta: { page, pageSize, total } });
});

adminRoutes.post("/refunds/:refundNo/query", async (c) => {
  const refundNo = z.string().max(40).parse(c.req.param("refundNo"));
  return c.json({ data: await queryRefund(null, refundNo) });
});

adminRoutes.get("/exceptions", async (c) => {
  const { page, pageSize, skip } = pageOf(c);
  const status = z.enum(["OPEN", "PROCESSING", "RESOLVED", "IGNORED"]).optional().parse(c.req.query("status"));
  const where = status ? { status } : {};
  const [rows, total] = await Promise.all([
    db.paymentException.findMany({
      where,
      include: {
        order: { select: { orderNo: true, subject: true } },
        payment: { select: { paymentNo: true, amount: true, receivedAmount: true, channelTradeNo: true } },
      },
      orderBy: [{ status: "asc" }, { severity: "desc" }, { detectedAt: "desc" }],
      skip,
      take: pageSize,
    }),
    db.paymentException.count({ where }),
  ]);
  return c.json({ data: rows, meta: { page, pageSize, total } });
});

adminRoutes.post("/exceptions/:id/status", async (c) => {
  const input = z.object({
    status: z.enum(["PROCESSING", "RESOLVED", "IGNORED"]),
    resolution: z.string().trim().min(2).max(500),
    resolutionRef: z.string().trim().max(80).optional(),
  }).parse(await c.req.json());
  return c.json({ data: await updatePaymentException(c.req.param("id"), input) });
});

adminRoutes.get("/reconciliation/runs", async (c) => {
  const { page, pageSize, skip } = pageOf(c);
  const [rows, total] = await Promise.all([
    db.reconciliationRun.findMany({ orderBy: [{ statementDate: "desc" }, { createdAt: "desc" }], skip, take: pageSize }),
    db.reconciliationRun.count(),
  ]);
  return c.json({ data: rows, meta: { page, pageSize, total } });
});

adminRoutes.get("/reconciliation/receipts", async (c) => {
  const { page, pageSize, skip } = pageOf(c);
  const status = z.enum(["UNMATCHED", "PROCESSING", "MATCHED", "MISMATCH", "IGNORED"]).optional().parse(c.req.query("status"));
  const where = status ? { matchStatus: status } : {};
  const [rows, total] = await Promise.all([
    db.receipt.findMany({
      where,
      include: {
        payment: { select: { paymentNo: true, order: { select: { orderNo: true, subject: true } } } },
        refund: { select: { refundNo: true, externalRefundNo: true } },
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip, take: pageSize,
    }),
    db.receipt.count({ where }),
  ]);
  return c.json({ data: jsonSafe(rows), meta: { page, pageSize, total } });
});

adminRoutes.post("/reconciliation/alipay/import", async (c) => {
  const input = z.object({
    statementDate: z.string(),
    fileName: z.string(),
    csvText: z.string(),
  }).parse(await c.req.json());
  return c.json({ data: await importAlipayBill(input) }, 201);
});

adminRoutes.post("/reconciliation/receipts/:id/match", async (c) => {
  const id = z.string().max(40).parse(c.req.param("id"));
  return c.json({ data: await matchReceipt(id) });
});

adminRoutes.get("/webhooks", async (c) => {
  const { page, pageSize, skip } = pageOf(c);
  const [rows, total] = await Promise.all([
    db.webhookDelivery.findMany({ include: { application: { select: { name: true } }, order: { select: { orderNo: true, externalOrderNo: true } } }, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
    db.webhookDelivery.count(),
  ]);
  return c.json({ data: rows, meta: { page, pageSize, total } });
});

adminRoutes.post("/payments/:paymentNo/query", async (c) => {
  const paymentNo = z.string().max(40).parse(c.req.param("paymentNo"));
  return c.json({ data: await queryPayment(null, paymentNo) });
});

adminRoutes.post("/payments/:paymentNo/close", async (c) => {
  const paymentNo = z.string().max(40).parse(c.req.param("paymentNo"));
  return c.json({ data: await closePayment(null, paymentNo) });
});

adminRoutes.post("/webhooks/:id/retry", async (c) => {
  const delivery = await db.webhookDelivery.update({ where: { id: c.req.param("id") }, data: { status: "PENDING", nextAttemptAt: new Date(), lockedUntil: null, lastError: null } });
  return c.json({ data: delivery });
});

async function channelStatus() {
  const cfg = config();
  const bill = await billRuntimeConfig();
  const alipay = {
    appId: Boolean(cfg.ALIPAY_APP_ID),
    privateKey: Boolean(cfg.ALIPAY_PRIVATE_KEY),
    publicKey: Boolean(cfg.ALIPAY_PUBLIC_KEY),
  };
  return {
    alipay: {
      code: "ALIPAY",
      name: "支付宝当面付",
      ready: alipay.appId && alipay.privateKey && alipay.publicKey,
      environment: cfg.ALIPAY_GATEWAY.includes("openapi.alipay.com") ? "生产环境" : "沙箱或自定义网关",
      gateway: cfg.ALIPAY_GATEWAY,
      webhookUrl: `${cfg.API_PUBLIC_URL}/api/v1/channels/alipay/webhook`,
      checks: alipay,
    },
    alipayBill: {
      code: "ALIPAY_BILL",
      name: "支付宝账单收款",
      ready: bill.ALIPAY_BILL_ENABLED && Boolean(bill.ALIPAY_BILL_QR_CONTENT) && ((bill.ALIPAY_BILL_COLLECTOR_ENABLED && Boolean(bill.ALIPAY_APP_ID && bill.ALIPAY_PRIVATE_KEY && bill.ALIPAY_PUBLIC_KEY && /^2088\d{12}$/.test(bill.ALIPAY_BILL_USER_ID))) || bill.ALIPAY_BILL_WATCHER_TOKEN.length >= 24),
      enabled: bill.ALIPAY_BILL_ENABLED,
      qrContent: Boolean(bill.ALIPAY_BILL_QR_CONTENT),
      watcherToken: bill.ALIPAY_BILL_WATCHER_TOKEN.length >= 24,
      matchMode: bill.ALIPAY_BILL_MATCH_MODE,
      validSeconds: bill.ALIPAY_BILL_VALID_SECONDS,
      watcherUrl: `${cfg.API_PUBLIC_URL}/api/v1/channels/alipay-bill/flows`,
    },
    mock: {
      code: "MOCK",
      name: "Mock 模拟支付",
      ready: cfg.MOCK_CHANNEL_ENABLED && Boolean(cfg.MOCK_CHANNEL_TOKEN),
      enabled: cfg.MOCK_CHANNEL_ENABLED,
      token: Boolean(cfg.MOCK_CHANNEL_TOKEN),
    },
  };
}
