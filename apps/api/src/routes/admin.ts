import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { db } from "../db.js";
import { jsonSafe } from "../lib/json.js";
import { adminAuth } from "../middleware/auth.js";
import { createApplication, rotateApplicationApiKey } from "../services/application-service.js";
import { queryPayment } from "../services/payment-service.js";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", adminAuth);

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
  const [applications, ordersToday, successfulToday, unknownPayments, pendingWebhooks, amount] = await Promise.all([
    db.application.count({ where: { status: "ACTIVE" } }),
    db.order.count({ where: { createdAt: { gte: start } } }),
    db.order.count({ where: { paidAt: { gte: start } } }),
    db.payment.count({ where: { status: "UNKNOWN" } }),
    db.webhookDelivery.count({ where: { status: { in: ["PENDING", "PROCESSING", "DEAD"] } } }),
    db.payment.aggregate({ where: { status: "SUCCESS", paidAt: { gte: start } }, _sum: { amount: true } }),
  ]);
  const recentEvents = await db.paymentEvent.findMany({ orderBy: { id: "desc" }, take: 12 });
  return c.json({ data: jsonSafe({ applications, ordersToday, successfulToday, amountToday: amount._sum.amount ?? 0, unknownPayments, pendingWebhooks, recentEvents }) });
});

adminRoutes.get("/applications", async (c) => {
  const applications = await db.application.findMany({ orderBy: { createdAt: "desc" }, select: {
    id: true, appId: true, epayPid: true, name: true, status: true, webhookUrl: true, defaultChannel: true, createdAt: true, updatedAt: true,
  } });
  return c.json({ data: applications });
});

adminRoutes.post("/applications", async (c) => {
  const input = z.object({
    name: z.string().trim().min(1).max(120),
    webhookUrl: z.string().url().max(500).optional().or(z.literal("")),
    defaultChannel: z.enum(["ALIPAY", "MOCK"]).default("MOCK"),
  }).parse(await c.req.json());
  const result = await createApplication({ ...input, webhookUrl: input.webhookUrl || null });
  return c.json({ data: result }, 201);
});

adminRoutes.post("/applications/:id/rotate-api-key", async (c) => {
  return c.json({ data: await rotateApplicationApiKey(c.req.param("id")) });
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
  const order = await db.order.findUnique({ where: { orderNo: c.req.param("orderNo") }, include: {
    application: { select: { name: true, appId: true } }, payments: { include: { refunds: true } }, events: { orderBy: { id: "asc" } }, webhookDeliveries: { orderBy: { createdAt: "asc" } },
  } });
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

adminRoutes.get("/webhooks", async (c) => {
  const { page, pageSize, skip } = pageOf(c);
  const [rows, total] = await Promise.all([
    db.webhookDelivery.findMany({ include: { application: { select: { name: true } }, order: { select: { orderNo: true, externalOrderNo: true } } }, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
    db.webhookDelivery.count(),
  ]);
  return c.json({ data: rows, meta: { page, pageSize, total } });
});

adminRoutes.post("/payments/:paymentNo/query", async (c) => {
  return c.json({ data: await queryPayment(null, c.req.param("paymentNo")) });
});

adminRoutes.post("/webhooks/:id/retry", async (c) => {
  const delivery = await db.webhookDelivery.update({ where: { id: c.req.param("id") }, data: { status: "PENDING", nextAttemptAt: new Date(), lockedUntil: null, lastError: null } });
  return c.json({ data: delivery });
});
