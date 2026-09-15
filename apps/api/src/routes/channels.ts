import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { config } from "../config.js";
import { safeEqual } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { handleAlipayWebhook, mockSucceed, publicPayment } from "../services/payment-service.js";

export const channelRoutes = new Hono<AppEnv>();

channelRoutes.post("/alipay/webhook", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const payload = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, Array.isArray(value) ? String(value[0] ?? "") : String(value)]));
  await handleAlipayWebhook(payload);
  return c.text("success");
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
