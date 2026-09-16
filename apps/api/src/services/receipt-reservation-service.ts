import type { Payment, Prisma } from "@prisma/client";
import { billRuntimeConfig } from "./bill-settings-service.js";
import { AppError } from "../lib/errors.js";

export const ALIPAY_BILL_ACCOUNT_ID = "alipay-bill-default";

export async function prepareReceiptPayment(
  tx: Prisma.TransactionClient,
  payment: Payment,
  orderExpiresAt: Date | null,
): Promise<Payment> {
  if (payment.channel !== "ALIPAY_BILL") return payment;
  const accountId = payment.channelId || ALIPAY_BILL_ACCOUNT_ID;
  const cfg = await billRuntimeConfig(tx, true, accountId);
  if (!cfg.ALIPAY_BILL_ENABLED) throw new AppError("ALIPAY_BILL_NOT_CONFIGURED", "支付宝账单收款通道尚未启用", 409);

  await tx.receiptAccount.upsert({
    where: { id: accountId },
    create: { id: accountId, name: "支付宝账单收款默认账号" },
    update: {},
  });
  await tx.$queryRaw`SELECT id FROM receipt_accounts WHERE id = ${accountId} FOR UPDATE`;
  const now = new Date();
  await tx.receiptMatchReservation.deleteMany({ where: { accountId, expiresAt: { lte: now } } });
  const configuredUntil = new Date(now.getTime() + cfg.ALIPAY_BILL_VALID_SECONDS * 1_000);
  const validUntil = orderExpiresAt && orderExpiresAt < configuredUntil ? orderExpiresAt : configuredUntil;
  if (validUntil <= now) throw new AppError("ORDER_EXPIRED", "订单已过期", 409);

  const mode = cfg.ALIPAY_BILL_MATCH_MODE;
  let channelAmount = payment.amount;
  let value: string;
  if (mode === "AMOUNT") {
    const active = await tx.receiptMatchReservation.findMany({
      where: { accountId, mode: "AMOUNT", expiresAt: { gt: now } },
      select: { value: true },
    });
    const used = new Set(active.map(item => item.value));
    const offset = Array.from({ length: cfg.ALIPAY_BILL_AMOUNT_OFFSET_MAX + 1 }, (_, index) => index)
      .find(index => !used.has(String(payment.amount + index)));
    if (offset === undefined) throw new AppError("RECEIPT_AMOUNT_POOL_EXHAUSTED", "当前收款账号可用金额偏移已用尽，请稍后重试", 409);
    channelAmount = payment.amount + offset;
    value = String(channelAmount);
  } else {
    value = `TX${payment.paymentNo.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase()}`;
  }

  await tx.receiptMatchReservation.create({ data: {
    accountId,
    mode,
    value,
    paymentId: payment.id,
    expiresAt: validUntil,
  } });
  return tx.payment.update({ where: { id: payment.id }, data: {
    channelAmount,
    receiptMatchMode: mode,
    receiptMatchReference: value,
    receiptValidFrom: now,
    receiptValidUntil: validUntil,
  } });
}
