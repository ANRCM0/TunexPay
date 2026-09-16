import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { applicationAuth } from "../middleware/auth.js";
import { createOrder, createOrderSchema, findApplicationOrder } from "../services/order-service.js";
import { closePayment, createPayment, createPaymentSchema, getPayment, queryPayment } from "../services/payment-service.js";
import { createRefund, createRefundSchema, queryRefund } from "../services/refund-service.js";

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

nativeRoutes.post("/refunds", async (c) => {
  const input = createRefundSchema.parse(await c.req.json());
  const refund = await createRefund(c.get("application"), input);
  return c.json({ data: refund }, 201);
});

nativeRoutes.post("/refunds/:refundNo/query", async (c) => {
  const refundNo = z.string().max(40).parse(c.req.param("refundNo"));
  return c.json({ data: await queryRefund(c.get("application").id, refundNo) });
});
