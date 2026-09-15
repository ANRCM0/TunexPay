import { Prisma, type Application, type Refund, type RefundStatus } from "@prisma/client";
import { z } from "zod";
import { channelFor } from "../channels/registry.js";
import { db } from "../db.js";
import { generateId, sha256, stableJson } from "../lib/crypto.js";
import { AppError, ChannelDefinitiveError, ChannelUncertainError, errorMessage } from "../lib/errors.js";
import { assertRefundTransition, refundedOrderStatus } from "../lib/state-machine.js";
import { createRefundSucceededDelivery } from "./outbox-service.js";

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
        paymentId: payment.id, amount: input.amount, reason: input.reason,
      } });
      await tx.paymentEvent.create({ data: {
        aggregateType: "REFUND", aggregateId: created.refundNo, orderId: payment.orderId, paymentId: payment.id,
        type: "REFUND_CREATED", source: "API", payload: { amount: created.amount, externalRefundNo: created.externalRefundNo },
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
    const result = await channelFor(payment.channel).refund({
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

async function updateRefund(refund: Refund, status: RefundStatus, data: Record<string, unknown>) {
  assertRefundTransition(refund.status, status);
  return db.$transaction(async (tx) => {
    const updated = await tx.refund.update({ where: { id: refund.id }, data: { status, ...data } });
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "REFUND", aggregateId: refund.refundNo, orderId: payment.orderId, paymentId: payment.id,
      type: `REFUND_${status}`, source: "CHANNEL", payload: {
        errorCode: typeof data.errorCode === "string" ? data.errorCode : null,
        errorMessage: typeof data.errorMessage === "string" ? data.errorMessage : null,
      },
    } });
    return updated;
  });
}

async function finalizeRefund(refund: Refund, status: RefundStatus, raw: unknown, channelRefundNo?: string) {
  if (status !== "SUCCESS") return updateRefund(refund, status, { rawResponse: raw as Prisma.InputJsonValue, channelRefundNo });
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM refunds WHERE id = ${refund.id} FOR UPDATE`;
    const current = await tx.refund.findUniqueOrThrow({ where: { id: refund.id } });
    if (current.status === "SUCCESS") return current;
    assertRefundTransition(current.status, "SUCCESS");
    const succeededAt = new Date();
    const updated = await tx.refund.update({ where: { id: current.id }, data: {
      status: "SUCCESS", succeededAt, channelRefundNo, rawResponse: raw as Prisma.InputJsonValue,
      errorCode: null, errorMessage: null,
    } });
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: current.paymentId }, include: { order: { include: { application: true } } } });
    const total = await tx.refund.aggregate({ where: { paymentId: payment.id, status: "SUCCESS" }, _sum: { amount: true } });
    const orderStatus = refundedOrderStatus(total._sum.amount ?? current.amount, payment.order.amount);
    const order = await tx.order.update({ where: { id: payment.orderId }, data: { status: orderStatus } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "REFUND", aggregateId: updated.refundNo, orderId: order.id, paymentId: payment.id,
      type: "REFUND_SUCCEEDED", source: "CHANNEL", payload: { amount: updated.amount, orderStatus },
    } });
    await createRefundSucceededDelivery(tx, payment.order.application, order, payment, updated);
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
