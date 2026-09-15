import { Hono, type Context } from "hono";
import type { Application } from "@prisma/client";
import type { AppEnv } from "../types.js";
import { db } from "../db.js";
import { openSealed, safeEqual, verifyEpaySign } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { centsToYuan, yuanToCents } from "../lib/money.js";
import { createOrder } from "../services/order-service.js";
import { createPayment } from "../services/payment-service.js";
import { createRefund } from "../services/refund-service.js";

export const epayRoutes = new Hono<AppEnv>();

async function requestParams(c: Context<AppEnv>): Promise<Record<string, string>> {
  const query = c.req.query();
  if (c.req.method === "GET") return query;
  const body = await c.req.parseBody({ all: true });
  return { ...query, ...Object.fromEntries(Object.entries(body).map(([key, value]) => [key, Array.isArray(value) ? String(value[0] ?? "") : String(value)])) };
}

async function findApplication(params: Record<string, string>): Promise<Application> {
  const pid = params.pid ?? "";
  const application = await db.application.findUnique({ where: { epayPid: pid } });
  if (!application || application.status !== "ACTIVE") throw new AppError("EPAY_AUTH_FAILED", "商户不存在或已禁用", 401);
  return application;
}

async function authenticateSigned(params: Record<string, string>): Promise<Application> {
  const application = await findApplication(params);
  if ((params.sign_type || "").toUpperCase() !== "MD5") throw new AppError("EPAY_SIGN_TYPE_INVALID", "仅支持 MD5 签名", 401);
  if (!verifyEpaySign(params, openSealed(application.epayKeyEncrypted))) throw new AppError("EPAY_SIGN_INVALID", "签名校验失败", 401);
  return application;
}

async function authenticateApiKey(params: Record<string, string>): Promise<Application> {
  const application = await findApplication(params);
  const key = params.key ?? "";
  if (!key || !safeEqual(key, openSealed(application.epayKeyEncrypted))) throw new AppError("EPAY_AUTH_FAILED", "商户密钥错误", 401);
  return application;
}

function required(params: Record<string, string>, key: string): string {
  const value = params[key]?.trim();
  if (!value) throw new AppError("EPAY_INVALID_PARAMETER", `缺少参数 ${key}`);
  return value;
}

async function createEpayPayment(application: Application, params: Record<string, string>) {
  const externalOrderNo = required(params, "out_trade_no");
  const orderResult = await createOrder(application, {
    externalOrderNo,
    amount: yuanToCents(required(params, "money")),
    currency: "CNY",
    subject: required(params, "name"),
    metadata: { param: params.param ?? "" },
    notifyUrl: params.notify_url || application.webhookUrl || undefined,
    returnUrl: params.return_url || undefined,
    expiresInSeconds: 1_800,
  }, `epay-order:${externalOrderNo}`, "EPAY_V1");
  const payment = await createPayment(application, orderResult.order.orderNo, {
    channel: application.defaultChannel,
    method: params.type || "alipay",
  }, `epay-payment:${externalOrderNo}`);
  return { order: orderResult.order, payment };
}

async function submit(c: Context<AppEnv>) {
  try {
    const params = await requestParams(c);
    const application = await authenticateSigned(params);
    const { payment } = await createEpayPayment(application, params);
    return c.redirect(payment.cashierUrl, 302);
  } catch (error) {
    const message = error instanceof Error ? error.message : "支付请求失败";
    return c.html(`<html lang="zh-CN"><meta charset="utf-8"><title>支付请求失败</title><body><h1>支付请求失败</h1><p>${escapeHtml(message)}</p></body></html>`, 400);
  }
}

async function mapi(c: Context<AppEnv>) {
  try {
    const params = await requestParams(c);
    const application = await authenticateSigned(params);
    const { payment } = await createEpayPayment(application, params);
    const payload = payment.clientPayload as Record<string, unknown> | null;
    return c.json({
      code: 1,
      msg: "success",
      trade_no: payment.paymentNo,
      payurl: payment.cashierUrl,
      qrcode: payload?.type === "qr_code" ? payload.value : payment.cashierUrl,
    });
  } catch (error) {
    return c.json({ code: 0, msg: error instanceof Error ? error.message : "支付请求失败" }, 400);
  }
}

async function api(c: Context<AppEnv>) {
  try {
    const params = await requestParams(c);
    const application = await authenticateApiKey(params);
    const act = (params.act || "query").toLowerCase();
    if (act === "query") {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const yesterday = new Date(start.getTime() - 86_400_000);
      const [orders, orderToday, orderLastday] = await Promise.all([
        db.order.count({ where: { applicationId: application.id } }),
        db.order.count({ where: { applicationId: application.id, createdAt: { gte: start } } }),
        db.order.count({ where: { applicationId: application.id, createdAt: { gte: yesterday, lt: start } } }),
      ]);
      return c.json({ code: 1, pid: application.epayPid, key: params.key, active: 1, money: "0.00", type: 4, account: "", username: application.name, orders, order_today: orderToday, order_lastday: orderLastday });
    }
    if (act === "order") {
      const order = await db.order.findFirst({
        where: {
          applicationId: application.id,
          ...(params.out_trade_no ? { externalOrderNo: params.out_trade_no } : { payments: { some: { paymentNo: required(params, "trade_no") } } }),
        },
        include: { payments: { orderBy: { attemptNo: "desc" }, take: 1 } },
      });
      if (!order) throw new AppError("ORDER_NOT_FOUND", "订单不存在", 404);
      const payment = order.payments[0];
      return c.json({
        code: 1, msg: "查询订单号成功！", trade_no: payment?.paymentNo ?? "", out_trade_no: order.externalOrderNo,
        type: payment?.method ?? "alipay", pid: application.epayPid, addtime: Math.floor(order.createdAt.getTime() / 1000),
        endtime: order.paidAt ? Math.floor(order.paidAt.getTime() / 1000) : null, name: order.subject,
        money: centsToYuan(order.amount), status: ["SUCCESS", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.status) ? 1 : 0,
      });
    }
    if (act === "orders") {
      const page = Math.max(1, Number.parseInt(params.page || "1", 10) || 1);
      const limit = Math.min(100, Math.max(1, Number.parseInt(params.limit || "20", 10) || 20));
      const orders = await db.order.findMany({ where: { applicationId: application.id }, include: { payments: { orderBy: { attemptNo: "desc" }, take: 1 } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit });
      return c.json({ code: 1, msg: "查询订单记录成功！", data: orders.map((order) => {
        const payment = order.payments[0];
        return { trade_no: payment?.paymentNo ?? "", out_trade_no: order.externalOrderNo, type: payment?.method ?? "alipay", pid: application.epayPid, addtime: Math.floor(order.createdAt.getTime() / 1000), endtime: order.paidAt ? Math.floor(order.paidAt.getTime() / 1000) : null, name: order.subject, money: centsToYuan(order.amount), status: ["SUCCESS", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.status) ? 1 : 0 };
      }) });
    }
    if (act === "refund") {
      const payment = params.trade_no
        ? await db.payment.findFirst({ where: { paymentNo: params.trade_no, order: { applicationId: application.id } } })
        : await db.payment.findFirst({ where: { order: { applicationId: application.id, externalOrderNo: required(params, "out_trade_no") }, status: "SUCCESS" } });
      if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
      const refund = await createRefund(application, {
        paymentNo: payment.paymentNo,
        externalRefundNo: params.out_refund_no || `epay-${payment.paymentNo}-${params.money}`,
        amount: yuanToCents(required(params, "money")),
        reason: "ePay V1 refund",
      });
      return c.json({ code: refund.status === "SUCCESS" ? 1 : 0, msg: refund.status === "SUCCESS" ? "退款成功" : `退款状态：${refund.status}`, refund_no: refund.refundNo, money: centsToYuan(refund.amount) });
    }
    throw new AppError("EPAY_UNSUPPORTED_ACTION", "不支持的操作类型");
  } catch (error) {
    return c.json({ code: 0, msg: error instanceof Error ? error.message : "请求失败" }, 400);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]!);
}

epayRoutes.get("/submit.php", submit);
epayRoutes.post("/submit.php", submit);
epayRoutes.get("/mapi.php", mapi);
epayRoutes.post("/mapi.php", mapi);
epayRoutes.get("/api.php", api);
epayRoutes.post("/api.php", api);
