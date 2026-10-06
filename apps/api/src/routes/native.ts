import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { applicationAuth } from "../middleware/auth.js";
import { AppError } from "../lib/errors.js";
import { createOrder, createOrderSchema, findApplicationOrder } from "../services/order-service.js";
import { closePayment, createPayment, createPaymentSchema, getPayment, queryPayment } from "../services/payment-service.js";
import { queryRefund } from "../services/refund-service.js";

export const nativeRoutes = new Hono<AppEnv>();
nativeRoutes.use("/orders", applicationAuth);
nativeRoutes.use("/orders/*", applicationAuth);
nativeRoutes.use("/payments/*", applicationAuth);
nativeRoutes.use("/refunds", applicationAuth);
nativeRoutes.use("/refunds/*", applicationAuth);

nativeRoutes.post("/orders", async (c) => {
  const input = createOrderSchema.parse(await c.req.json());
  const result = await createOrder(c.get("application"), input, c.req.header("idempotency-key"));
  return c.json({ data: result.order, meta: { reused: result.reused } }, result.reused ? 200 : 201);
});

nativeRoutes.get("/orders/:orderNo", async (c) => {
  const order = await findApplicationOrder(c.get("application").id, c.req.param("orderNo"));
  return c.json({ data: order });
});

nativeRoutes.post("/orders/:orderNo/pay", async (c) => {
  const input = createPaymentSchema.parse(await c.req.json().catch(() => ({})));
  const payment = await createPayment(c.get("application"), c.req.param("orderNo"), input, c.req.header("idempotency-key"));
  return c.json({ data: payment }, 201);
});

nativeRoutes.get("/payments/:paymentNo", async (c) => {
  const paymentNo = z.string().max(40).parse(c.req.param("paymentNo"));
  const payment = await getPayment(c.get("application").id, paymentNo);
  return c.json({ data: payment });
});

nativeRoutes.post("/payments/:paymentNo/query", async (c) => {
  const paymentNo = z.string().max(40).parse(c.req.param("paymentNo"));
  const payment = await queryPayment(c.get("application").id, paymentNo);
  return c.json({ data: payment });
});

nativeRoutes.post("/payments/:paymentNo/close", async (c) => {
  const paymentNo = z.string().max(40).parse(c.req.param("paymentNo"));
  return c.json({ data: await closePayment(c.get("application").id, paymentNo) });
});

// 退款不由商户 API 执行：保留路由但一律拒绝，让老接入方能拿到明确的错误码，
// 而不是一个含义模糊的 404；同时也避免上游重试循环把一个已失效的入口当作偶发失败继续打。
// 退款只能由管理员人工发起：管理台「退款记录 → 人工发起退款」，或经 MCP 审批（15 分钟人工确认）。
nativeRoutes.post("/refunds", () => {
  throw new AppError("REFUND_API_DISABLED", "退款接口已停用：系统不再自动执行退款，请由管理员人工发起", 410);
});

nativeRoutes.post("/refunds/:refundNo/query", async (c) => {
  const refundNo = z.string().max(40).parse(c.req.param("refundNo"));
  return c.json({ data: await queryRefund(c.get("application").id, refundNo) });
});
