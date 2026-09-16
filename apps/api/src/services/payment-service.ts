import { Prisma, type Application, type Payment, type PaymentChannelCode, type PaymentStatus } from "@prisma/client";
import { z } from "zod";
import { channelFor } from "../channels/registry.js";
import type { ChannelWebhookResult } from "../channels/types.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { generateId } from "../lib/crypto.js";
import { AppError, ChannelDefinitiveError, ChannelUncertainError, errorMessage } from "../lib/errors.js";
import { RECOVERY_MAX_ATTEMPTS, initialRecoveryAt, isRecoverablePayment, recoveryAt } from "../lib/recovery-policy.js";
import { assertPaymentTransition, canPaymentTransition } from "../lib/state-machine.js";
import { createPaymentSucceededDelivery } from "./outbox-service.js";
import { openLateDuplicateException } from "./payment-exception-service.js";
import { prepareReceiptPayment } from "./receipt-reservation-service.js";

export const createPaymentSchema = z.object({
  channel: z.enum(["ALIPAY", "ALIPAY_BILL", "MOCK"]).optional(),
  method: z.string().trim().min(1).max(32).default("alipay"),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export async function createPayment(application: Application, orderNo: string, input: CreatePaymentInput, idempotencyKey?: string) {
  const key = idempotencyKey?.trim() || null;
  if (key && key.length > 120) throw new AppError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 不能超过 120 个字符");
  const channel = input.channel ?? application.defaultChannel;
  const dispatch = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM orders WHERE orderNo = ${orderNo} FOR UPDATE`;
    const order = await tx.order.findFirst({ where: { orderNo, applicationId: application.id } });
    if (!order) throw new AppError("ORDER_NOT_FOUND", "订单不存在", 404);
    if (order.expiresAt && order.expiresAt <= new Date()) throw new AppError("ORDER_EXPIRED", "订单已过期", 409);
    if (!["CREATED", "PENDING"].includes(order.status)) throw new AppError("ORDER_NOT_PAYABLE", `订单状态 ${order.status} 不允许发起支付`, 409);
    if (key) {
      const existing = await tx.payment.findUnique({ where: { orderId_idempotencyKey: { orderId: order.id, idempotencyKey: key } } });
      if (existing) return { payment: existing, shouldDispatch: false };
    }
    const count = await tx.payment.count({ where: { orderId: order.id } });
    const created = await tx.payment.create({
      data: {
        paymentNo: generateId("pay"),
        orderId: order.id,
        attemptNo: count + 1,
        idempotencyKey: key,
        channel,
        method: input.method,
        amount: order.amount,
        channelAmount: order.amount,
      },
    });
    const prepared = await prepareReceiptPayment(tx, created, order.expiresAt);
    await tx.order.update({ where: { id: order.id }, data: { status: "PENDING" } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "PAYMENT", aggregateId: prepared.paymentNo, orderId: order.id, paymentId: prepared.id,
      type: "PAYMENT_CREATED", source: "API", payload: {
        channel, attemptNo: prepared.attemptNo, channelAmount: prepared.channelAmount,
        receiptMatchMode: prepared.receiptMatchMode, receiptMatchReference: prepared.receiptMatchReference,
      },
    } });
    const processing = await tx.payment.update({ where: { id: prepared.id }, data: {
      status: "PROCESSING", nextQueryAt: channel === "ALIPAY" ? initialRecoveryAt() : null,
    } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "PAYMENT", aggregateId: created.paymentNo, orderId: order.id, paymentId: created.id,
      type: "CHANNEL_CREATE_REQUESTED", source: "API", payload: { channel },
    } });
    return { payment: processing, shouldDispatch: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  const payment = dispatch.payment;
  if (!dispatch.shouldDispatch) return presentPayment(payment);
  const order = await db.order.findUniqueOrThrow({ where: { id: payment.orderId } });
  try {
    const result = await channelFor(channel).create({
      paymentNo: payment.paymentNo,
      amount: payment.channelAmount,
      businessAmount: payment.amount,
      subject: order.subject,
      description: order.description,
      notifyUrl: `${config().API_PUBLIC_URL}/api/v1/channels/${channel.toLowerCase()}/webhook`,
      matchReference: payment.receiptMatchMode === "REMARK" ? payment.receiptMatchReference : null,
      validUntil: payment.receiptValidUntil,
    });
    const updated = await updatePaymentObservation(payment, result.status, {
      channelOrderNo: result.channelOrderNo,
      channelTradeNo: result.channelTradeNo,
      clientPayload: result.clientPayload,
      rawResponse: result.raw as Prisma.InputJsonValue,
    });
    return presentPayment(updated);
  } catch (error) {
    const status: PaymentStatus = error instanceof ChannelUncertainError ? "UNKNOWN" : "FAILED";
    const updated = await updatePaymentObservation(payment, status, {
      errorCode: error instanceof ChannelDefinitiveError ? error.code : status === "UNKNOWN" ? "CHANNEL_RESULT_UNKNOWN" : "CHANNEL_ERROR",
      errorMessage: errorMessage(error).slice(0, 500),
    });
    return presentPayment(updated);
  }
}

async function updatePaymentObservation(payment: Payment, status: PaymentStatus, data: Record<string, unknown>, source = "CHANNEL"): Promise<Payment> {
  assertPaymentTransition(payment.status, status);
  return db.$transaction(async (tx) => {
    const updated = await tx.payment.update({ where: { id: payment.id }, data: {
      status,
      ...data,
      nextQueryAt: payment.channel === "ALIPAY" && isRecoverablePayment(status) ? recoveryAt(Math.max(1, payment.queryAttempts)) : null,
    } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "PAYMENT", aggregateId: payment.paymentNo, orderId: payment.orderId, paymentId: payment.id,
      type: `PAYMENT_${status}`, source, payload: {
        errorCode: typeof data.errorCode === "string" ? data.errorCode : null,
        errorMessage: typeof data.errorMessage === "string" ? data.errorMessage : null,
      },
    } });
    return updated;
  });
}

export async function markPaymentSucceeded(result: ChannelWebhookResult, source: string): Promise<Payment> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE paymentNo = ${result.paymentNo} FOR UPDATE`;
    const current = await tx.payment.findUnique({ where: { paymentNo: result.paymentNo } });
    if (!current) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
    if (current.amount !== result.amount) throw new AppError("PAYMENT_AMOUNT_MISMATCH", "通道回调金额与支付单金额不一致", 409, { expected: current.amount, actual: result.amount });
    if (current.status === "SUCCESS") {
      if (current.channelTradeNo && result.channelTradeNo && current.channelTradeNo !== result.channelTradeNo) {
        throw new AppError("PAYMENT_TRADE_CONFLICT", "成功支付单对应了不同的通道交易号", 409, {
          expected: current.channelTradeNo,
          actual: result.channelTradeNo,
        });
      }
      if (current.receivedAmount && result.receivedAmount && current.receivedAmount !== result.receivedAmount) {
        throw new AppError("PAYMENT_RECEIVED_AMOUNT_CONFLICT", "成功支付单对应了不同的实收金额", 409, {
          expected: current.receivedAmount,
          actual: result.receivedAmount,
        });
      }
      return current;
    }
    assertPaymentTransition(current.status, "SUCCESS");
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${current.orderId} FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: current.orderId }, include: { application: true } });
    const paidAt = result.paidAt ?? new Date();
    const payment = await tx.payment.update({ where: { id: current.id }, data: {
      status: "SUCCESS",
      channelTradeNo: result.channelTradeNo,
      receivedAmount: result.receivedAmount ?? result.amount,
      paidAt,
      errorCode: null,
      errorMessage: null,
      rawResponse: result.raw,
      nextQueryAt: null,
    } });
    const isLateDuplicate = order.status === "SUCCESS" || order.status === "PARTIALLY_REFUNDED" || order.status === "REFUNDED";
    await tx.paymentEvent.create({ data: {
      aggregateType: "PAYMENT", aggregateId: payment.paymentNo, orderId: order.id, paymentId: payment.id,
      type: isLateDuplicate ? "PAYMENT_LATE_DUPLICATE" : "PAYMENT_SUCCEEDED", source,
      payload: { previousStatus: current.status, channelTradeNo: result.channelTradeNo, paidAt: paidAt.toISOString() },
    } });
    if (isLateDuplicate) {
      await openLateDuplicateException(tx, {
        orderId: order.id,
        orderNo: order.orderNo,
        winningPaymentId: order.winningPaymentId,
        paymentId: payment.id,
        paymentNo: payment.paymentNo,
        amount: payment.amount,
        receivedAmount: payment.receivedAmount ?? payment.amount,
        channelTradeNo: payment.channelTradeNo ?? undefined,
        source,
      });
      return payment;
    }
    const updatedOrder = await tx.order.update({ where: { id: order.id }, data: {
      status: "SUCCESS", paidAt, winningPaymentId: payment.id,
      expirationNextAttemptAt: null, expirationLockedUntil: null, expirationError: null,
    } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "ORDER", aggregateId: order.orderNo, orderId: order.id, paymentId: payment.id,
      type: "ORDER_SUCCEEDED", source, payload: { paymentNo: payment.paymentNo },
    } });
    await createPaymentSucceededDelivery(tx, order.application, updatedOrder, payment);
    return payment;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function queryPayment(applicationId: string | null, paymentNo: string) {
  const payment = await db.payment.findFirst({ where: { paymentNo, ...(applicationId ? { order: { applicationId } } : {}) }, include: { order: true } });
  if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
  const result = await channelFor(payment.channel).query(payment.paymentNo);
  if (result.status === "SUCCESS") {
    const succeeded = await markPaymentSucceeded({
      eventKey: `query:${payment.paymentNo}:${result.channelTradeNo ?? "success"}`,
      paymentNo: payment.paymentNo,
      status: "SUCCESS",
      amount: payment.amount,
      channelTradeNo: result.channelTradeNo,
      paidAt: result.paidAt,
      raw: result.raw as Prisma.InputJsonValue,
    }, "QUERY");
    return presentPayment(succeeded);
  }
  if (payment.status !== result.status && payment.status !== "SUCCESS" && canPaymentTransition(payment.status, result.status)) {
    return presentPayment(await updatePaymentObservation(payment, result.status, { rawResponse: result.raw as Prisma.InputJsonValue }, "QUERY"));
  }
  if (payment.channel === "ALIPAY" && isRecoverablePayment(payment.status) && !payment.nextQueryAt && payment.queryAttempts < RECOVERY_MAX_ATTEMPTS) {
    return presentPayment(await db.payment.update({ where: { id: payment.id }, data: { nextQueryAt: initialRecoveryAt() } }));
  }
  return presentPayment(payment);
}

export async function getPayment(applicationId: string, paymentNo: string) {
  const payment = await db.payment.findFirst({ where: { paymentNo, order: { applicationId } } });
  if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
  return presentPayment(payment);
}

export async function closePayment(applicationId: string | null, paymentNo: string, source = "API") {
  const payment = await db.payment.findFirst({ where: { paymentNo, ...(applicationId ? { order: { applicationId } } : {}) } });
  if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
  if (payment.status === "SUCCESS" || payment.status === "CLOSED") return presentPayment(payment);
  if (!["CREATED", "PROCESSING", "UNKNOWN"].includes(payment.status)) throw new AppError("PAYMENT_NOT_CLOSABLE", `支付状态 ${payment.status} 不允许关闭`, 409);
  const result = await channelFor(payment.channel).close(payment.paymentNo);
  if (!result.closed) return presentPayment(payment);
  const updated = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE paymentNo = ${paymentNo} FOR UPDATE`;
    const current = await tx.payment.findUniqueOrThrow({ where: { paymentNo } });
    if (current.status === "SUCCESS" || current.status === "CLOSED") return current;
    assertPaymentTransition(current.status, "CLOSED");
    const closed = await tx.payment.update({ where: { id: current.id }, data: { status: "CLOSED", rawResponse: result.raw as Prisma.InputJsonValue, nextQueryAt: null } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "PAYMENT", aggregateId: current.paymentNo, orderId: current.orderId, paymentId: current.id,
      type: "PAYMENT_CLOSED", source, payload: {},
    } });
    return closed;
  });
  return presentPayment(updated);
}

export async function handleAlipayWebhook(payload: Record<string, string>): Promise<void> {
  const result = await channelFor("ALIPAY").handleWebhook(payload);
  let callback;
  try {
    callback = await db.channelCallback.create({ data: {
      channel: "ALIPAY", eventKey: result.eventKey, paymentNo: result.paymentNo, verified: true, rawPayload: payload,
    } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      callback = await db.channelCallback.findUniqueOrThrow({ where: { channel_eventKey: { channel: "ALIPAY", eventKey: result.eventKey } } });
      if (callback.processed) return;
    } else {
      throw error;
    }
  }
  try {
    if (result.status === "SUCCESS") await markPaymentSucceeded(result, "ALIPAY_WEBHOOK");
    await db.channelCallback.update({ where: { id: callback.id }, data: { processed: true, processedAt: new Date() } });
  } catch (error) {
    await db.channelCallback.update({ where: { id: callback.id }, data: { errorMessage: errorMessage(error).slice(0, 500) } });
    throw error;
  }
}

export async function mockSucceed(paymentNo: string): Promise<Payment> {
  const payment = await db.payment.findUnique({ where: { paymentNo } });
  if (!payment || payment.channel !== "MOCK") throw new AppError("PAYMENT_NOT_FOUND", "模拟支付单不存在", 404);
  return markPaymentSucceeded({
    eventKey: `mock:${paymentNo}`, paymentNo, status: "SUCCESS", amount: payment.amount,
    channelTradeNo: `mock_${paymentNo}`, paidAt: new Date(), raw: { mock: "true" },
  }, "MOCK");
}

export async function publicPayment(paymentNo: string) {
  const payment = await db.payment.findUnique({ where: { paymentNo }, include: { order: true } });
  if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
  return {
    paymentNo: payment.paymentNo,
    status: payment.status,
    channel: payment.channel,
    method: payment.method,
    amount: payment.channelAmount,
    businessAmount: payment.amount,
    currency: payment.order.currency,
    subject: payment.order.subject,
    clientPayload: payment.clientPayload,
    returnUrl: payment.order.returnUrl,
    paidAt: payment.paidAt,
  };
}

export function presentPayment(payment: Payment) {
  return { ...payment, cashierUrl: `${config().WEB_PUBLIC_URL}/cashier/${payment.paymentNo}` };
}
