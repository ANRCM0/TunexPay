import { Prisma, type Application, type Refund, type RefundStatus } from "@prisma/client";
import { z } from "zod";
import { adapterForPayment } from "./channel-instance-service.js";
import { db } from "../db.js";
import { generateId, sha256, stableJson } from "../lib/crypto.js";
import { AppError, ChannelDefinitiveError, ChannelUncertainError, errorMessage } from "../lib/errors.js";
import { RECOVERY_MAX_ATTEMPTS, initialRecoveryAt, isRecoverableRefund, recoveryAt } from "../lib/recovery-policy.js";
import { assertRefundTransition, canRefundTransition, refundedOrderStatus } from "../lib/state-machine.js";
import { createRefundSucceededDelivery } from "./outbox-service.js";
import { resolveLateDuplicateExceptionAfterRefund } from "./payment-exception-service.js";

export const createRefundSchema = z.object({
  paymentNo: z.string().min(1).max(40),
  externalRefundNo: z.string().min(1).max(80),
  amount: z.number().int().positive().max(999_999_999),
  reason: z.string().trim().max(300).optional(),
});

export type CreateRefundInput = z.infer<typeof createRefundSchema>;

export async function createRefund(application: Application, input: CreateRefundInput) {
  const requestHash = sha256(stableJson(input));
  const existing = await db.refund.findUnique({ where: { applicationId_externalRefundNo: { applicationId: application.id, externalRefundNo: input.externalRefundNo } } });
  if (existing) {
    const oldHash = sha256(stableJson({ paymentNo: (await db.payment.findUniqueOrThrow({ where: { id: existing.paymentId } })).paymentNo, externalRefundNo: existing.externalRefundNo, amount: existing.amount, reason: existing.reason ?? undefined }));
    if (oldHash !== requestHash) throw new AppError("IDEMPOTENCY_CONFLICT", "相同退款单号对应了不同请求", 409);
    return existing;
  }

  let dispatch: { refund: Refund; shouldDispatch: boolean };
  try {
    dispatch = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payments WHERE paymentNo = ${input.paymentNo} FOR UPDATE`;
      const payment = await tx.payment.findFirst({ where: { paymentNo: input.paymentNo, order: { applicationId: application.id } }, include: { order: true } });
      if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
      if (payment.status !== "SUCCESS") throw new AppError("PAYMENT_NOT_REFUNDABLE", "只有成功支付单可以退款", 409);
      const raced = await tx.refund.findUnique({ where: { applicationId_externalRefundNo: { applicationId: application.id, externalRefundNo: input.externalRefundNo } } });
      if (raced) return { refund: raced, shouldDispatch: false };
      const reserved = await tx.refund.aggregate({
        where: { paymentId: payment.id, status: { in: ["CREATED", "PROCESSING", "UNKNOWN", "SUCCESS"] } },
        _sum: { amount: true },
      });
      if ((reserved._sum.amount ?? 0) + input.amount > payment.amount) throw new AppError("REFUND_AMOUNT_EXCEEDED", "退款金额超过可退金额", 409);
      const created = await tx.refund.create({ data: {
        refundNo: generateId("ref"), externalRefundNo: input.externalRefundNo, applicationId: application.id,
        paymentId: payment.id, amount: input.amount, reason: input.reason, status: "PROCESSING",
        nextQueryAt: payment.channel === "ALIPAY" ? initialRecoveryAt() : null,
      } });
      await tx.paymentEvent.create({ data: {
        aggregateType: "REFUND", aggregateId: created.refundNo, orderId: payment.orderId, paymentId: payment.id,
        type: "REFUND_CREATED", source: "API", payload: { amount: created.amount, externalRefundNo: created.externalRefundNo },
      } });
      await tx.paymentEvent.create({ data: {
        aggregateType: "REFUND", aggregateId: created.refundNo, orderId: payment.orderId, paymentId: payment.id,
        type: "CHANNEL_REFUND_REQUESTED", source: "API", payload: { channel: payment.channel },
      } });
      return { refund: created, shouldDispatch: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const raced = await db.refund.findUnique({ where: { applicationId_externalRefundNo: { applicationId: application.id, externalRefundNo: input.externalRefundNo } } });
    if (!raced) throw error;
    dispatch = { refund: raced, shouldDispatch: false };
  }

  const refund = dispatch.refund;
  if (!dispatch.shouldDispatch) {
    const oldHash = sha256(stableJson({ paymentNo: (await db.payment.findUniqueOrThrow({ where: { id: refund.paymentId } })).paymentNo, externalRefundNo: refund.externalRefundNo, amount: refund.amount, reason: refund.reason ?? undefined }));
    if (oldHash !== requestHash) throw new AppError("IDEMPOTENCY_CONFLICT", "相同退款单号对应了不同请求", 409);
    return refund;
  }

  try {
    const payment = await db.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
    const result = await (await adapterForPayment(payment)).refund({
      paymentNo: payment.paymentNo, refundNo: refund.refundNo, channelTradeNo: payment.channelTradeNo,
      amount: refund.amount, reason: refund.reason,
    });
    return finalizeRefund(refund, result.status, result.raw, result.channelRefundNo);
  } catch (error) {
    const status: RefundStatus = error instanceof ChannelUncertainError ? "UNKNOWN" : "FAILED";
    return updateRefund(refund, status, {
      errorCode: error instanceof ChannelDefinitiveError ? error.code : status === "UNKNOWN" ? "CHANNEL_RESULT_UNKNOWN" : "CHANNEL_ERROR",
      errorMessage: errorMessage(error).slice(0, 500),
    });
  }
}

async function updateRefund(refund: Refund, status: RefundStatus, data: Record<string, unknown>, source = "CHANNEL") {
  assertRefundTransition(refund.status, status);
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
    const updated = await tx.refund.update({ where: { id: refund.id }, data: {
      status,
      ...data,
      nextQueryAt: payment.channel === "ALIPAY" && isRecoverableRefund(status) ? recoveryAt(Math.max(1, refund.queryAttempts)) : null,
    } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "REFUND", aggregateId: refund.refundNo, orderId: payment.orderId, paymentId: payment.id,
      type: `REFUND_${status}`, source, payload: {
        errorCode: typeof data.errorCode === "string" ? data.errorCode : null,
        errorMessage: typeof data.errorMessage === "string" ? data.errorMessage : null,
      },
    } });
    return updated;
  });
}

async function finalizeRefund(refund: Refund, status: RefundStatus, raw: unknown, channelRefundNo?: string, source = "CHANNEL") {
  if (status !== "SUCCESS") return updateRefund(refund, status, { rawResponse: raw as Prisma.InputJsonValue, channelRefundNo }, source);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM refunds WHERE id = ${refund.id} FOR UPDATE`;
    const current = await tx.refund.findUniqueOrThrow({ where: { id: refund.id } });
    if (current.status === "SUCCESS") return current;
    assertRefundTransition(current.status, "SUCCESS");
    const succeededAt = new Date();
    const updated = await tx.refund.update({ where: { id: current.id }, data: {
      status: "SUCCESS", succeededAt, channelRefundNo, rawResponse: raw as Prisma.InputJsonValue,
      errorCode: null, errorMessage: null, nextQueryAt: null,
    } });
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: current.paymentId }, include: { order: { include: { application: true } } } });
    const total = await tx.refund.aggregate({ where: { paymentId: payment.id, status: "SUCCESS" }, _sum: { amount: true } });
    const isWinningPayment = payment.order.winningPaymentId === payment.id;
    const orderStatus = isWinningPayment
      ? refundedOrderStatus(total._sum.amount ?? current.amount, payment.order.amount)
      : payment.order.status;
    const order = isWinningPayment
      ? await tx.order.update({ where: { id: payment.orderId }, data: { status: orderStatus } })
      : payment.order;
    await tx.paymentEvent.create({ data: {
      aggregateType: "REFUND", aggregateId: updated.refundNo, orderId: order.id, paymentId: payment.id,
      type: "REFUND_SUCCEEDED", source, payload: { amount: updated.amount, orderStatus, isWinningPayment },
    } });
    if ((total._sum.amount ?? current.amount) >= payment.amount) {
      await resolveLateDuplicateExceptionAfterRefund(tx, { paymentId: payment.id, orderId: order.id, refundNo: updated.refundNo });
    }
    if (isWinningPayment) await createRefundSucceededDelivery(tx, payment.order.application, order, payment, updated);
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function queryRefund(applicationId: string | null, refundNo: string) {
  const refund = await db.refund.findFirst({
    where: { refundNo, ...(applicationId ? { applicationId } : {}) },
    include: { payment: true },
  });
  if (!refund) throw new AppError("REFUND_NOT_FOUND", "退款单不存在", 404);
  const result = await (await adapterForPayment(refund.payment)).queryRefund({
    paymentNo: refund.payment.paymentNo,
    refundNo: refund.refundNo,
    channelTradeNo: refund.payment.channelTradeNo,
  });
  if (result.status === "SUCCESS") return finalizeRefund(refund, "SUCCESS", result.raw, result.channelRefundNo, "QUERY");
  if (refund.status !== result.status && refund.status !== "SUCCESS" && canRefundTransition(refund.status, result.status)) {
    return updateRefund(refund, result.status, { rawResponse: result.raw as Prisma.InputJsonValue, channelRefundNo: result.channelRefundNo }, "QUERY");
  }
  if (refund.payment.channel === "ALIPAY" && isRecoverableRefund(refund.status) && !refund.nextQueryAt && refund.queryAttempts < RECOVERY_MAX_ATTEMPTS) {
    return db.refund.update({ where: { id: refund.id }, data: { nextQueryAt: initialRecoveryAt() } });
  }
  return refund;
}

export async function markRefundSucceededFromReceipt(refundNo: string, amount: number, raw: Prisma.InputJsonValue, channelRefundNo?: string | null) {
  const refund = await db.refund.findUnique({ where: { refundNo } });
  if (!refund) throw new AppError("REFUND_NOT_FOUND", "退款单不存在", 404);
  if (refund.amount !== amount) throw new AppError("REFUND_AMOUNT_MISMATCH", "账单退款金额与退款单金额不一致", 409, { expected: refund.amount, actual: amount });
  return finalizeRefund(refund, "SUCCESS", raw, channelRefundNo ?? refund.channelRefundNo ?? undefined, "ALIPAY_BILL");
}
