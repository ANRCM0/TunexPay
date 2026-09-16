import { db } from "../db.js";
import { AppError, errorMessage } from "../lib/errors.js";
import { EXPIRATION_LOCK_SECONDS, expirationRetryAt } from "../lib/expiration-policy.js";
import { closePayment, queryPayment } from "./payment-service.js";

type ExpirationSummary = { claimed: number; closed: number; paid: number; skipped: number; failed: number };

export async function runDueOrderExpirations(limit = 20): Promise<ExpirationSummary> {
  const now = new Date();
  const due = await db.order.findMany({
    where: {
      status: { in: ["CREATED", "PENDING"] },
      expiresAt: { lte: now },
      expirationNextAttemptAt: { lte: now },
      OR: [{ expirationLockedUntil: null }, { expirationLockedUntil: { lt: now } }],
    },
    select: { id: true, orderNo: true, expirationAttempts: true },
    orderBy: [{ expirationNextAttemptAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  const summary: ExpirationSummary = { claimed: 0, closed: 0, paid: 0, skipped: 0, failed: 0 };
  for (const item of due) {
    const lockedUntil = new Date(Date.now() + EXPIRATION_LOCK_SECONDS * 1_000);
    const claimed = await db.order.updateMany({
      where: {
        id: item.id,
        status: { in: ["CREATED", "PENDING"] },
        expirationAttempts: item.expirationAttempts,
        expirationNextAttemptAt: { lte: new Date() },
        OR: [{ expirationLockedUntil: null }, { expirationLockedUntil: { lt: new Date() } }],
      },
      data: { expirationAttempts: { increment: 1 }, expirationLockedUntil: lockedUntil, expirationError: null },
    });
    if (!claimed.count) continue;
    summary.claimed += 1;
    const attempt = item.expirationAttempts + 1;
    try {
      const outcome = await expireOrder(item.orderNo);
      summary[outcome] += 1;
    } catch (error) {
      summary.failed += 1;
      const message = errorMessage(error).slice(0, 500);
      await db.$transaction(async (tx) => {
        const current = await tx.order.findUnique({ where: { id: item.id }, select: { status: true } });
        if (!current || !["CREATED", "PENDING"].includes(current.status)) return;
        await tx.order.update({ where: { id: item.id }, data: {
          expirationLockedUntil: null,
          expirationNextAttemptAt: expirationRetryAt(attempt),
          expirationError: message,
        } });
        await tx.paymentEvent.create({ data: {
          aggregateType: "ORDER", aggregateId: item.orderNo, orderId: item.id,
          type: "ORDER_EXPIRATION_FAILED", source: "WORKER", payload: { attempt, error: message },
        } });
      });
    }
  }
  return summary;
}

async function expireOrder(orderNo: string): Promise<"closed" | "paid" | "skipped"> {
  const order = await db.order.findUnique({ where: { orderNo }, include: { payments: { orderBy: { attemptNo: "asc" } } } });
  if (!order || !["CREATED", "PENDING"].includes(order.status)) return "skipped";

  for (const payment of order.payments) {
    if (payment.status === "SUCCESS") throw new AppError("ORDER_PAYMENT_STATE_CONFLICT", "订单未成功但存在成功支付单，需要人工检查", 409);
    if (!["CREATED", "PROCESSING", "UNKNOWN"].includes(payment.status)) continue;
    if (payment.channel === "ALIPAY") {
      const observed = await queryPayment(null, payment.paymentNo);
      if (observed.status === "SUCCESS") {
        await releaseExpiration(order.id);
        return "paid";
      }
    }
    const closed = await closePayment(null, payment.paymentNo, "EXPIRATION");
    if (closed.status !== "CLOSED" && closed.status !== "SUCCESS") {
      throw new AppError("PAYMENT_CLOSE_UNCONFIRMED", `支付单 ${payment.paymentNo} 未确认关闭`, 409);
    }
    if (closed.status === "SUCCESS") {
      await releaseExpiration(order.id);
      return "paid";
    }
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
    const current = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    if (!["CREATED", "PENDING"].includes(current.status)) {
      await tx.order.update({ where: { id: current.id }, data: { expirationLockedUntil: null, expirationNextAttemptAt: null } });
      return current.status === "SUCCESS" || current.status === "PARTIALLY_REFUNDED" || current.status === "REFUNDED" ? "paid" : "skipped";
    }
    if (current.payments.some(payment => payment.status === "SUCCESS")) {
      throw new AppError("ORDER_PAYMENT_STATE_CONFLICT", "订单关闭前发现成功支付单，需要人工检查", 409);
    }
    if (current.payments.some(payment => ["CREATED", "PROCESSING", "UNKNOWN"].includes(payment.status))) {
      throw new AppError("ORDER_HAS_ACTIVE_PAYMENT", "仍有支付单尚未确认关闭", 409);
    }
    await tx.order.update({ where: { id: current.id }, data: {
      status: "CLOSED", closedAt: new Date(), expirationLockedUntil: null, expirationNextAttemptAt: null, expirationError: null,
    } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "ORDER", aggregateId: current.orderNo, orderId: current.id,
      type: "ORDER_EXPIRED", source: "WORKER", payload: { attempts: current.expirationAttempts },
    } });
    return "closed";
  });
}

async function releaseExpiration(orderId: string): Promise<void> {
  await db.order.update({ where: { id: orderId }, data: {
    expirationLockedUntil: null, expirationNextAttemptAt: null, expirationError: null,
  } });
}
