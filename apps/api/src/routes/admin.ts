import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { config } from "../config.js";
import { billRuntimeConfig, getPublicBillSettings } from "../services/bill-settings-service.js";
import { getOwnerSettings, saveOwnerSettings, testOwnerNotification } from "../services/owner-notification-service.js";
import { db } from "../db.js";
import { jsonSafe } from "../lib/json.js";
import { AppError } from "../lib/errors.js";
import { loadDashboardStats } from "../lib/dashboard-stats.js";
import { adminAuth } from "../middleware/auth.js";
import { adminAudit } from "../middleware/admin-audit.js";
import { createApplication, deleteApplication, rotateApplicationApiKey, rotateApplicationCredentials, updateApplicationStatus } from "../services/application-service.js";
import { closePayment, queryPayment } from "../services/payment-service.js";
import { updatePaymentException } from "../services/payment-exception-service.js";
import { queryRefund } from "../services/refund-service.js";
import { importAlipayBill, matchReceipt } from "../services/reconciliation-service.js";
import { collectSystemStatus } from "../lib/system-status.js";
import { routingGroupRoutes } from "./routing-groups.js";
import { channelInstanceRoutes } from "./channel-instances.js";
import { assignChannel, saveChannel, loadChannel, checkChannel } from "../services/channel-instance-service.js";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", adminAuth);
adminRoutes.use("*", adminAudit);
adminRoutes.route("/", channelInstanceRoutes);
adminRoutes.route("/", routingGroupRoutes);

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
  // 14 个计数合并为一条条件聚合 SQL（见 lib/dashboard-stats.ts），这里只剩两条语句：
  // 聚合 + recentEvents。
  const [stats, recentEvents] = await Promise.all([
    loadDashboardStats(start),
    db.paymentEvent.findMany({ where: { OR: [{ order: live }, { order: null }] }, orderBy: { id: "desc" }, take: 12 }),
  ]);
  return c.json({ data: jsonSafe({ ...stats, recentEvents }) });
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
      id: true, appId: true, epayPid: true, name: true, status: true, webhookUrl: true, defaultChannel: true, defaultChannelId: true, routingGroupId: true,
      routingGroup: { select: { id: true, name: true, enabled: true, strategy: true } },
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
    routingGroupId: z.string().min(1).max(80).optional(),
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

// 通道分配统一走 /applications/:id/channel-instance（在 channel-instances 路由里）。
// 早期的 /applications/:id/default-channel 依赖自动创建的默认通道，默认通道概念移除后一并删除。
//
// 账单收款配置面板保留原有路径，但不再假定 alipay-bill-default 一定存在：
// 改成解析「当前实际的 ALIPAY_BILL 通道」，找不到就给出明确指引。
async function resolveBillChannel() {
  const rows = await db.channelInstance.findMany({ where: { plugin: "ALIPAY_BILL", archivedAt: null }, orderBy: { createdAt: "asc" }, take: 1 });
  const row = rows[0];
  if (!row) throw new AppError("BILL_CHANNEL_NOT_CONFIGURED", "还没有支付宝账单收款通道，请先在「支付通道」创建并检测一个 ALIPAY_BILL 通道", 409);
  return row;
}

adminRoutes.get("/channels", async (c) => c.json({ data: await channelStatus() }));
adminRoutes.get("/channels/alipay-bill/settings", async (c) => c.json({ data: await getPublicBillSettings() }));
adminRoutes.post("/channels/alipay-bill/settings", async c => {
  const input = await c.req.json();
  const row = await resolveBillChannel();
  const bill = await getPublicBillSettings();
  if (input.revision !== bill.revision) throw new AppError("BILL_SETTINGS_CONFLICT", "账单配置已被修改，请重新加载后再保存", 409);
  await saveChannel({ name: row.name, plugin: row.plugin, enabled: input.enabled, revision: row.revision, settings: input }, row.id);
  return c.json({ data: await getPublicBillSettings() });
});
adminRoutes.get("/channels/alipay-bill/collector", async (c) => {
  const { alipayBillCollectorStatus } = await import("../services/alipay-bill-collector-service.js");
  return c.json({ data: await alipayBillCollectorStatus() });
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
