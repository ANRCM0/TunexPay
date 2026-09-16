import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { config } from "../config.js";
import { safeEqual } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { handleAlipayWebhook, mockSucceed, publicPayment } from "../services/payment-service.js";
import { ingestAlipayBillFlows } from "../services/receipt-flow-service.js";
import { billRuntimeConfig } from "../services/bill-settings-service.js";

export const channelRoutes = new Hono<AppEnv>();

channelRoutes.post("/alipay/webhook", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const payload = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, Array.isArray(value) ? String(value[0] ?? "") : String(value)]));
  await handleAlipayWebhook(payload);
  return c.text("success");
});

channelRoutes.post("/alipay-bill/flows", async (c) => {
  const cfg = await billRuntimeConfig();
  if (!cfg.ALIPAY_BILL_WATCHER_TOKEN) throw new AppError("NOT_FOUND", "接口不存在", 404);
  const token = c.req.header("x-watcher-token") || "";
  if (!token || !cfg.ALIPAY_BILL_WATCHER_TOKEN || !safeEqual(token, cfg.ALIPAY_BILL_WATCHER_TOKEN)) {
    throw new AppError("UNAUTHORIZED", "Watcher 令牌无效", 401);
  }
  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > 1_000_000) throw new AppError("RECEIPT_FLOW_PAYLOAD_TOO_LARGE", "流水请求体不能超过 1 MB", 413);
  const outcomes = await ingestAlipayBillFlows(await c.req.json());
  return c.json({ data: outcomes });
});

channelRoutes.post("/mock/:paymentNo/succeed", async (c) => {
  if (!config().MOCK_CHANNEL_ENABLED) throw new AppError("NOT_FOUND", "接口不存在", 404);
  const token = c.req.header("x-mock-token") || "";
  if (!token || !config().MOCK_CHANNEL_TOKEN || !safeEqual(token, config().MOCK_CHANNEL_TOKEN)) {
    throw new AppError("UNAUTHORIZED", "模拟通道令牌无效", 401);
  }
  const payment = await mockSucceed(c.req.param("paymentNo"));
  return c.json({ data: payment });
});

channelRoutes.get("/public/payments/:paymentNo", async (c) => {
  return c.json({ data: await publicPayment(c.req.param("paymentNo")) });
});
