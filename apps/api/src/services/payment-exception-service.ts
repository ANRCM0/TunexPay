import type {
  PaymentException,
  PaymentExceptionSeverity,
  PaymentExceptionStatus,
  PaymentExceptionType,
  Prisma,
} from "@prisma/client";
import { generateId } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { db } from "../db.js";

type OpenExceptionInput = {
  type: PaymentExceptionType;
  severity: PaymentExceptionSeverity;
  subjectType: string;
  subjectId: string;
  orderId?: string | null;
  paymentId?: string | null;
  source: string;
  summary: string;
  detail?: Prisma.InputJsonValue;
};

export async function openPaymentException(
  tx: Prisma.TransactionClient,
  input: OpenExceptionInput,
): Promise<PaymentException> {
  const key = {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    type: input.type,
  };
  const existing = await tx.paymentException.findUnique({
    where: { subjectType_subjectId_type: key },
  });
  const shouldReopen = existing && ["RESOLVED", "IGNORED"].includes(existing.status);
  const exception = existing
    ? await tx.paymentException.update({
        where: { id: existing.id },
        data: {
          severity: input.severity,
          status: shouldReopen ? "OPEN" : existing.status,
          orderId: input.orderId ?? existing.orderId,
          paymentId: input.paymentId ?? existing.paymentId,
          source: input.source,
          summary: input.summary,
          detail: input.detail,
          ...(shouldReopen ? { resolution: null, resolutionRef: null, resolvedAt: null } : {}),
        },
      })
    : await tx.paymentException.create({
        data: {
          exceptionNo: generateId("exc"),
          ...input,
        },
      });

  if ((!existing || shouldReopen) && input.paymentId && input.orderId) {
    await tx.paymentEvent.create({
      data: {
        aggregateType: "EXCEPTION",
        aggregateId: exception.exceptionNo,
        orderId: input.orderId,
        paymentId: input.paymentId,
        type: "PAYMENT_EXCEPTION_OPENED",
        source: input.source,
        payload: { exceptionNo: exception.exceptionNo, type: exception.type, severity: exception.severity },
      },
    });
  }
  return exception;
}

export function openLateDuplicateException(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    orderNo: string;
    winningPaymentId: string | null;
    paymentId: string;
    paymentNo: string;
    amount: number;
    receivedAmount: number;
    channelTradeNo?: string;
    source: string;
  },
): Promise<PaymentException> {
  return openPaymentException(tx, {
    type: "LATE_DUPLICATE",
    severity: "CRITICAL",
    subjectType: "PAYMENT",
    subjectId: input.paymentId,
    orderId: input.orderId,
    paymentId: input.paymentId,
    source: input.source,
    summary: `订单 ${input.orderNo} 出现晚到或重复支付，需核实并退款`,
    detail: {
      paymentNo: input.paymentNo,
      winningPaymentId: input.winningPaymentId,
      businessAmount: input.amount,
      receivedAmount: input.receivedAmount,
      channelTradeNo: input.channelTradeNo ?? null,
    },
  });
}

export async function updatePaymentException(
  id: string,
  input: { status: Extract<PaymentExceptionStatus, "PROCESSING" | "RESOLVED" | "IGNORED">; resolution: string; resolutionRef?: string },
): Promise<PaymentException> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payment_exceptions WHERE id = ${id} FOR UPDATE`;
    const current = await tx.paymentException.findUnique({ where: { id } });
    if (!current) throw new AppError("PAYMENT_EXCEPTION_NOT_FOUND", "支付异常不存在", 404);
    if (current.status === "RESOLVED" && input.status !== "RESOLVED") {
      throw new AppError("PAYMENT_EXCEPTION_ALREADY_RESOLVED", "已解决的支付异常不能重新流转", 409);
    }
    const updated = await tx.paymentException.update({
      where: { id },
      data: {
        status: input.status,
        resolution: input.resolution,
        resolutionRef: input.resolutionRef || null,
        resolvedAt: input.status === "PROCESSING" ? null : new Date(),
      },
    });
    if (current.paymentId && current.orderId && current.status !== updated.status) {
      await tx.paymentEvent.create({
        data: {
          aggregateType: "EXCEPTION",
          aggregateId: updated.exceptionNo,
          orderId: current.orderId,
          paymentId: current.paymentId,
          type: `PAYMENT_EXCEPTION_${updated.status}`,
          source: "ADMIN",
          payload: { resolution: updated.resolution, resolutionRef: updated.resolutionRef },
        },
      });
    }
    return updated;
  });
}

export async function resolveLateDuplicateExceptionAfterRefund(
  tx: Prisma.TransactionClient,
  input: { paymentId: string; orderId: string; refundNo: string },
): Promise<void> {
  const current = await tx.paymentException.findUnique({
    where: { subjectType_subjectId_type: { subjectType: "PAYMENT", subjectId: input.paymentId, type: "LATE_DUPLICATE" } },
  });
  if (!current || !["OPEN", "PROCESSING"].includes(current.status)) return;
  const updated = await tx.paymentException.update({ where: { id: current.id }, data: {
    status: "RESOLVED",
    resolution: "关联支付已完成全额退款",
    resolutionRef: input.refundNo,
    resolvedAt: new Date(),
  } });
  await tx.paymentEvent.create({ data: {
    aggregateType: "EXCEPTION",
    aggregateId: updated.exceptionNo,
    orderId: input.orderId,
    paymentId: input.paymentId,
    type: "PAYMENT_EXCEPTION_RESOLVED",
    source: "REFUND",
    payload: { resolution: updated.resolution, refundNo: input.refundNo },
  } });
}
