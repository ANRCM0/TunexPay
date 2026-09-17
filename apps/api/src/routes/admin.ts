import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { config } from "../config.js";
import { billRuntimeConfig, getPublicBillSettings } from "../services/bill-settings-service.js";
import { getOwnerSettings, saveOwnerSettings, testOwnerNotification } from "../services/owner-notification-service.js";
import { db } from "../db.js";
import { jsonSafe } from "../lib/json.js";
import { AppError } from "../lib/errors.js";
import { RECOVERY_MAX_ATTEMPTS } from "../lib/recovery-policy.js";
import { adminAuth } from "../middleware/auth.js";
import { adminAudit } from "../middleware/admin-audit.js";
import { createApplication, deleteApplication, rotateApplicationApiKey, rotateApplicationCredentials, updateApplicationStatus } from "../services/application-service.js";
import { closePayment, queryPayment } from "../services/payment-service.js";
import { updatePaymentException } from "../services/payment-exception-service.js";
import { queryRefund } from "../services/refund-service.js";
import { importAlipayBill, matchReceipt } from "../services/reconciliation-service.js";
import { collectSystemStatus } from "../lib/system-status.js";
import { channelInstanceRoutes } from "./channel-instances.js";
import { assignChannel, ensureLegacyChannels, saveChannel, loadChannel, checkChannel } from "../services/channel-instance-service.js";
import { legacyChannelId } from "../lib/channel-scope.js";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", adminAuth);
adminRoutes.use("*", adminAudit);
adminRoutes.route("/", channelInstanceRoutes);

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
  // 归档订单（随应用删除的历史数据）不进入任何一个计数：管理台只看在用业务。
  const live = { deletedAt: null };
  const [applications, ordersToday, successfulToday, unknownPayments, pendingWebhooks, amount, recoveringPayments, recoveringRefunds, exhaustedRecoveries, unmatchedReceipts, mismatchedReceipts, openPaymentExceptions, expirationFailures, failedAdminActionsToday] = await Promise.all([
    db.application.count({ where: { status: "ACTIVE", archivedAt: null } }),
    db.order.count({ where: { ...live, createdAt: { gte: start } } }),
    db.order.count({ where: { ...live, paidAt: { gte: start } } }),
    db.payment.count({ where: { status: "UNKNOWN", order: live } }),
    db.webhookDelivery.count({ where: { status: { in: ["PENDING", "PROCESSING", "DEAD"] }, order: live } }),
    db.payment.aggregate({ where: { status: "SUCCESS", paidAt: { gte: start }, order: live }, _sum: { amount: true } }),
    db.payment.count({ where: { channel: "ALIPAY", status: { in: ["PROCESSING", "UNKNOWN"] }, nextQueryAt: { not: null }, order: live } }),
    db.refund.count({ where: { payment: { channel: "ALIPAY", order: live }, status: { in: ["PROCESSING", "UNKNOWN"] }, nextQueryAt: { not: null } } }),
    Promise.all([
      db.payment.count({ where: { channel: "ALIPAY", status: { in: ["PROCESSING", "UNKNOWN"] }, nextQueryAt: null, queryAttempts: { gte: RECOVERY_MAX_ATTEMPTS }, order: live } }),
      db.refund.count({ where: { payment: { channel: "ALIPAY", order: live }, status: { in: ["PROCESSING", "UNKNOWN"] }, nextQueryAt: null, queryAttempts: { gte: RECOVERY_MAX_ATTEMPTS } } }),
    ]).then(([payments, refunds]) => payments + refunds),
    db.receipt.count({ where: { matchStatus: "UNMATCHED", OR: [{ payment: { order: live } }, { payment: null }] } }),
    db.receipt.count({ where: { matchStatus: "MISMATCH", OR: [{ payment: { order: live } }, { payment: null }] } }),
    db.paymentException.count({ where: { status: { in: ["OPEN", "PROCESSING"] }, OR: [{ order: live }, { order: null }] } }),
    db.order.count({ where: { ...live, status: { in: ["CREATED", "PENDING"] }, expirationError: { not: null } } }),
    db.adminAuditLog.count({ where: { success: false, createdAt: { gte: start } } }),
  ]);
  const recentEvents = await db.paymentEvent.findMany({ where: { OR: [{ order: live }, { order: null }] }, orderBy: { id: "desc" }, take: 12 });
  return c.json({ data: jsonSafe({
    applications, ordersToday, successfulToday, amountToday: amount._sum.amount ?? 0, unknownPayments, pendingWebhooks,
    recoveringPayments, recoveringRefunds, exhaustedRecoveries, unmatchedReceipts, mismatchedReceipts,
    openPaymentExceptions, expirationFailures, failedAdminActionsToday, recentEvents,
  }) });
});

adminRoutes.get("/system", async c => c.json({ data: jsonSafe(await collectSystemStatus()) }));

adminRoutes.get("/applications", async (c) => {
  // 归档应用（删除过的）仍然返回：列表要能显示「已归档」状态，否则删完就从页面上消失、
  // 看起来像数据丢了。前端默认只展示在用应用，可切换到「含已归档」。
  const includeArchived = z.enum(["true", "false"]).optional().parse(c.req.query("includeArchived")) === "true";
  const applications = await db.application.findMany({
    where: { appId: { not: "channel-diagnostics" }, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, appId: true, epayPid: true, name: true, status: true, webhookUrl: true, defaultChannel: true, defaultChannelId: true,
      archivedAt: true, pausedAt: true, createdAt: true, updatedAt: true,
      _count: { select: { orders: true, refunds: true, webhookDeliveries: true } },
    },
  });
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
    defaultChannelId: z.string().min(1).max(80).optional(),
  }).parse(await c.req.json());
  const result = await createApplication({ ...input, webhookUrl: input.webhookUrl || null });
  return c.json({ data: result }, 201);
});

adminRoutes.post("/applications/:id/rotate-api-key", async (c) => {
  return c.json({ data: await rotateApplicationApiKey(c.req.param("id")) });
});

adminRoutes.post("/applications/:id/rotate-credentials", async (c) => {
  return c.json({ data: await rotateApplicationCredentials(c.req.param("id")) });
});

// 管理端的变更接口统一走 POST 动作式路径（与查单 / 关闭 / 异常处置一致），
// 这样 BFF 代理无需放开 PATCH / DELETE，同源校验也能覆盖到这些写操作。
adminRoutes.post("/applications/:id/status", async (c) => {
  const { status } = z.object({ status: z.enum(["ACTIVE", "DISABLED"]) }).parse(await c.req.json());
  return c.json({ data: await updateApplicationStatus(c.req.param("id"), status) });
});

adminRoutes.post("/applications/:id/delete", async (c) => {
  // 有业务数据的应用走归档删除：凭证立即失效、订单等从在用数据集摘除，行保留以备追溯。
  return c.json({ data: await deleteApplication(c.req.param("id")) });
});

adminRoutes.post("/applications/:id/default-channel", async (c) => {
  const channel = z.enum(["ALIPAY", "ALIPAY_BILL", "MOCK"]).parse((await c.req.json()).channel);
  await ensureLegacyChannels();
  return c.json({ data: await assignChannel(c.req.param("id"), legacyChannelId(channel)) });
});

adminRoutes.get("/channels", async (c) => c.json({ data: await channelStatus() }));
adminRoutes.get("/channels/alipay-bill/settings", async (c) => c.json({ data: await getPublicBillSettings() }));
adminRoutes.post("/channels/alipay-bill/settings", async c => {
  await ensureLegacyChannels();
  const input = await c.req.json();
  const row = await loadChannel("alipay-bill-default");
  const bill = await getPublicBillSettings();
  if (input.revision !== bill.revision) throw new AppError("BILL_SETTINGS_CONFLICT", "???????????", 409);
  await saveChannel({ name: row.name, plugin: row.plugin, enabled: input.enabled, revision: row.revision, settings: input }, row.id);
  return c.json({ data: await getPublicBillSettings() });
});
adminRoutes.get("/channels/alipay-bill/collector", async (c) => {
  const { alipayBillCollectorStatus } = await import("../services/alipay-bill-collector-service.js");
  return c.json({ data: await alipayBillCollectorStatus() });
});

adminRoutes.post("/channels/alipay/check", async (c) => {
  await ensureLegacyChannels();
  const row = await loadChannel("alipay-default");
  return c.json({ data: await checkChannel(row.id, row.revision) });
});

const liveOrder = { deletedAt: null };

adminRoutes.get("/orders", async (c) => {
  const { page, pageSize, skip } = pageOf(c);
  const status = z.enum(["CREATED", "PENDING", "SUCCESS", "CLOSED", "PARTIALLY_REFUNDED", "REFUNDED"]).optional().parse(c.req.query("status"));
  // 归档订单（随应用删除的历史数据）不出现在在用列表里，但仍可用订单号直接打开查看。
  const where = { ...liveOrder, ...(status ? { status } : {}) };
  const [rows, total] = await Promise.all([
    db.order.findMany({ where, include: { application: { select: { name: true, appId: true } }, payments: { orderBy: { attemptNo: "desc" }, take: 1 } }, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
    db.order.count({ where }),
  ]);
  return c.json({ data: rows, meta: { page, pageSize, total } });
});

adminRoutes.get("/orders/:orderNo", async (c) => {
  const orderNo = z.string().max(40).parse(c.req.param("orderNo"));
  // 详情不做在用过滤：归档订单的唯一出口就是这里，排查历史资金流向要靠它。
  const order = await db.order.findUnique({ where: { orderNo }, include: {
    application: { select: { name: true, appId: true, archivedAt: true } }, payments: { include: { refunds: true }, orderBy: { attemptNo: "desc" } }, events: { orderBy: { id: "asc" } }, webhookDeliveries: { orderBy: { createdAt: "asc" } }, paymentExceptions: { orderBy: { detectedAt: "desc" } },
  } });
  if (!order) throw new AppError("ORDER_NOT_FOUND", "订单不存在", 404);
  return c.json({ data: jsonSafe(order) });
});

adminRoutes.get("/refunds", async (c) => {
  const { page, pageSize, skip } = pageOf(c);
  // 已归档应用的历史退款保留在库里（通道侧的钱已经动了），列表照常可查，前端会标出「已归档」。
  const [rows, total] = await Promise.all([
    db.refund.findMany({ include: { application: { select: { name: true, archivedAt: true } }, payment: { select: { paymentNo: true, order: { select: { orderNo: true, subject: true, deletedAt: true } } } } }, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
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
  const rawStatus = c.req.query("status");
  const status = z.enum(["OPEN", "PROCESSING", "RESOLVED", "IGNORED"]).optional().parse(rawStatus);
  // 挂在归档订单上的异常记录会随应用归档一起清掉，这里保留 order 为空的异常（对账类）。
  const where = { OR: [{ order: liveOrder }, { order: null }], ...(rawStatus && status ? { status } : {}) };
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
  // 归档应用的通知投递已被清掉，这里再兜一层，避免历史残留混进在用列表。
  const where = { order: liveOrder };
  const [rows, total] = await Promise.all([
    db.webhookDelivery.findMany({ where, include: { application: { select: { name: true } }, order: { select: { orderNo: true, externalOrderNo: true } } }, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
    db.webhookDelivery.count({ where }),
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
