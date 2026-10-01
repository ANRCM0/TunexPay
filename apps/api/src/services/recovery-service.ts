import type { PaymentStatus } from "@prisma/client";
import { db } from "../db.js";
import { errorMessage } from "../lib/errors.js";
import { RECOVERY_MAX_ATTEMPTS, isRecoverablePayment, recoveryDelaySeconds } from "../lib/recovery-policy.js";
import { queryPayment } from "./payment-service.js";

// 这里只做支付单的自动查单。退款不做自动查单：退款状态只由管理员在退款页手动查单推进，
// Worker 不再认领退款记录，也不再有退款侧的退避重排或查单上限耗尽。

type RecoverySummary = { claimed: number; resolved: number; failed: number; exhausted: number };

export async function runDuePaymentRecoveries(limit = 20): Promise<RecoverySummary> {
  const due = await db.payment.findMany({
    where: {
      channel: "ALIPAY",
      status: { in: ["PROCESSING", "UNKNOWN"] },
      nextQueryAt: { lte: new Date() },
      queryAttempts: { lt: RECOVERY_MAX_ATTEMPTS },
    },
    select: { id: true, paymentNo: true, queryAttempts: true },
    orderBy: [{ nextQueryAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  const summary: RecoverySummary = { claimed: 0, resolved: 0, failed: 0, exhausted: 0 };
  for (const item of due) {
    const attempt = item.queryAttempts + 1;
    const nextQueryAt = new Date(Date.now() + recoveryDelaySeconds(attempt) * 1_000);
    const claimed = await db.payment.updateMany({
      where: {
        id: item.id,
        status: { in: ["PROCESSING", "UNKNOWN"] },
        queryAttempts: item.queryAttempts,
        nextQueryAt: { lte: new Date() },
      },
      data: { queryAttempts: { increment: 1 }, lastQueriedAt: new Date(), nextQueryAt },
    });
    if (!claimed.count) continue;
    summary.claimed += 1;
    try {
      const result = await queryPayment(null, item.paymentNo);
      if (!isRecoverablePayment(result.status)) summary.resolved += 1;
      else if (attempt >= RECOVERY_MAX_ATTEMPTS && await exhaustPayment(item.id, item.paymentNo, result.status, attempt)) summary.exhausted += 1;
    } catch (error) {
      summary.failed += 1;
      const message = errorMessage(error).slice(0, 500);
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM payments WHERE id = ${item.id} FOR UPDATE`;
        const current = await tx.payment.findUnique({ where: { id: item.id }, select: { orderId: true, status: true } });
        if (!current || !isRecoverablePayment(current.status)) return;
        const exhausted = attempt >= RECOVERY_MAX_ATTEMPTS;
        await tx.payment.update({ where: { id: item.id }, data: {
          errorCode: "RECOVERY_QUERY_ERROR", errorMessage: message, nextQueryAt: exhausted ? null : nextQueryAt,
        } });
        await tx.paymentEvent.create({ data: {
          aggregateType: "PAYMENT", aggregateId: item.paymentNo, orderId: current.orderId, paymentId: item.id,
          type: exhausted ? "PAYMENT_RECOVERY_EXHAUSTED" : "PAYMENT_RECOVERY_QUERY_FAILED", source: "WORKER",
          payload: { attempt, error: message },
        } });
        if (exhausted) summary.exhausted += 1;
      });
    }
  }
  return summary;
}

async function exhaustPayment(id: string, paymentNo: string, status: PaymentStatus, attempt: number): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${id} FOR UPDATE`;
    const current = await tx.payment.findUnique({ where: { id }, select: { orderId: true, status: true, nextQueryAt: true } });
    if (!current || !isRecoverablePayment(current.status) || !current.nextQueryAt) return false;
    await tx.payment.update({ where: { id }, data: { nextQueryAt: null } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "PAYMENT", aggregateId: paymentNo, orderId: current.orderId, paymentId: id,
      type: "PAYMENT_RECOVERY_EXHAUSTED", source: "WORKER", payload: { attempt, status },
    } });
    return true;
  });
}
