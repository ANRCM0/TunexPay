import { Prisma, type Receipt, type ReceiptMatchStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.js";
import { parseAlipayBill, type ParsedReceipt } from "../lib/alipay-bill.js";
import { sha256, stableJson } from "../lib/crypto.js";
import { AppError, errorMessage } from "../lib/errors.js";
import { markPaymentSucceeded } from "./payment-service.js";
import { markRefundSucceededFromReceipt } from "./refund-service.js";
import { rematchAlipayBillReceipt } from "./receipt-flow-service.js";

const importSchema = z.object({
  statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fileName: z.string().trim().min(1).max(255),
  csvText: z.string().min(1).max(5_000_000),
});

export type ReconciliationImportInput = z.infer<typeof importSchema>;

export async function importAlipayBill(input: ReconciliationImportInput) {
  const parsedInput = importSchema.parse(input);
  const statementDate = parseStatementDate(parsedInput.statementDate);
  const run = await db.reconciliationRun.upsert({
    where: { provider_statementDate: { provider: "ALIPAY", statementDate } },
    create: { provider: "ALIPAY", statementDate, fileName: parsedInput.fileName },
    update: {
      status: "PROCESSING", fileName: parsedInput.fileName, importedCount: 0, duplicateCount: 0, matchedCount: 0,
      mismatchedCount: 0, unmatchedCount: 0, skippedCount: 0, errorMessage: null, startedAt: new Date(), completedAt: null,
    },
  });
  try {
    const parsed = parseAlipayBill(parsedInput.csvText);
    const counts = { imported: 0, duplicate: 0, matched: 0, mismatched: 0, unmatched: 0 };
    for (const item of parsed.receipts) {
      const result = await ingestAndMatch(statementDate, item);
      result.duplicate ? counts.duplicate += 1 : counts.imported += 1;
      if (result.status === "MATCHED") counts.matched += 1;
      else if (result.status === "MISMATCH") counts.mismatched += 1;
      else counts.unmatched += 1;
    }
    return db.reconciliationRun.update({ where: { id: run.id }, data: {
      status: "SUCCESS", importedCount: counts.imported, duplicateCount: counts.duplicate, matchedCount: counts.matched,
      mismatchedCount: counts.mismatched, unmatchedCount: counts.unmatched, skippedCount: parsed.skipped, completedAt: new Date(),
    } });
  } catch (error) {
    await db.reconciliationRun.update({ where: { id: run.id }, data: {
      status: "FAILED", errorMessage: errorMessage(error).slice(0, 500), completedAt: new Date(),
    } });
    throw error;
  }
}

export async function matchReceipt(id: string): Promise<Receipt> {
  const receipt = await db.receipt.findUnique({ where: { id } });
  if (!receipt) throw new AppError("RECEIPT_NOT_FOUND", "账单流水不存在", 404);
  if (receipt.provider === "ALIPAY_BILL") return rematchAlipayBillReceipt(receipt.id);
  return receipt.direction === "INCOME" ? matchIncome(receipt) : matchRefund(receipt);
}

async function ingestAndMatch(statementDate: Date, item: ParsedReceipt): Promise<{ duplicate: boolean; status: ReceiptMatchStatus }> {
  const fingerprint = sha256(stableJson({
    provider: "ALIPAY", statementDate: statementDate.toISOString().slice(0, 10), direction: item.direction,
    providerTradeNo: item.providerTradeNo, merchantOrderNo: item.merchantOrderNo,
    providerRefundNo: item.providerRefundNo, merchantRefundNo: item.merchantRefundNo,
    amount: item.amount, occurredAt: item.occurredAt.toISOString(),
  }));
  let receipt: Receipt;
  let duplicate = false;
  try {
    receipt = await db.receipt.create({ data: {
      provider: "ALIPAY", statementDate, direction: item.direction, providerTradeNo: item.providerTradeNo,
      merchantOrderNo: item.merchantOrderNo, providerRefundNo: item.providerRefundNo, merchantRefundNo: item.merchantRefundNo,
      amount: item.amount, occurredAt: item.occurredAt, fingerprint, rawPayload: item.rawPayload,
    } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    duplicate = true;
    receipt = await db.receipt.findUniqueOrThrow({ where: { fingerprint } });
  }
  const matched = await matchReceipt(receipt.id);
  return { duplicate, status: matched.matchStatus };
}

async function matchIncome(receipt: Receipt): Promise<Receipt> {
  if (!receipt.merchantOrderNo && !receipt.providerTradeNo) return markUnmatched(receipt, "账单缺少商户订单号和支付宝交易号");
  const [byMerchant, byTrade] = await Promise.all([
    receipt.merchantOrderNo ? db.payment.findFirst({ where: { channel: "ALIPAY", OR: [{ paymentNo: receipt.merchantOrderNo }, { channelOrderNo: receipt.merchantOrderNo }] }, include: { order: true } }) : null,
    receipt.providerTradeNo ? db.payment.findUnique({ where: { channelTradeNo: receipt.providerTradeNo }, include: { order: true } }) : null,
  ]);
  if (byTrade && byTrade.channel !== "ALIPAY") {
    return markMismatch(receipt, `支付宝交易号已被非支付宝支付单 ${byTrade.paymentNo} 占用`, byTrade.id, null, byTrade.orderId);
  }
  if (byMerchant && byTrade && byMerchant.id !== byTrade.id) {
    return markMismatch(receipt, `商户订单号与支付宝交易号分别指向 ${byMerchant.paymentNo} 和 ${byTrade.paymentNo}`, byMerchant.id, null, byMerchant.orderId);
  }
  const payment = byMerchant ?? byTrade;
  if (!payment) return markUnmatched(receipt, "未找到对应支付单");
  if (payment.amount !== receipt.amount) return markMismatch(receipt, `支付金额不一致：系统 ${payment.amount} 分，账单 ${receipt.amount} 分`, payment.id, null, payment.orderId);
  if (payment.channelTradeNo && receipt.providerTradeNo && payment.channelTradeNo !== receipt.providerTradeNo) {
    return markMismatch(receipt, `支付宝交易号不一致：系统 ${payment.channelTradeNo}，账单 ${receipt.providerTradeNo}`, payment.id, null, payment.orderId);
  }
  await markPaymentSucceeded({
    eventKey: `receipt:${receipt.fingerprint}`, paymentNo: payment.paymentNo, status: "SUCCESS", amount: receipt.amount,
    channelTradeNo: receipt.providerTradeNo ?? payment.channelTradeNo ?? undefined, paidAt: receipt.occurredAt,
    raw: receipt.rawPayload as Prisma.InputJsonValue,
  }, "ALIPAY_BILL");
  if (!payment.channelTradeNo && receipt.providerTradeNo) {
    await db.payment.update({ where: { id: payment.id }, data: { channelTradeNo: receipt.providerTradeNo } });
  }
  return markMatched(receipt, payment.id, null, payment.orderId);
}

async function matchRefund(receipt: Receipt): Promise<Receipt> {
  if (!receipt.merchantRefundNo && !receipt.providerRefundNo) return markUnmatched(receipt, "退款流水缺少商户退款单号");
  const [byMerchant, byProviderCandidates] = await Promise.all([
    receipt.merchantRefundNo ? db.refund.findFirst({ where: { payment: { channel: "ALIPAY" }, OR: [{ refundNo: receipt.merchantRefundNo }, { externalRefundNo: receipt.merchantRefundNo }] }, include: { payment: true } }) : null,
    receipt.providerRefundNo ? db.refund.findMany({ where: { payment: { channel: "ALIPAY" }, channelRefundNo: receipt.providerRefundNo }, include: { payment: true }, take: 2 }) : [],
  ]);
  if (byProviderCandidates.length > 1 && !byMerchant) {
    const candidate = byProviderCandidates[0]!;
    return markMismatch(receipt, "支付宝退款号对应多笔本地退款，必须使用商户退款单号确认", candidate.paymentId, candidate.id, candidate.payment.orderId);
  }
  if (byMerchant && byProviderCandidates.length && !byProviderCandidates.some(candidate => candidate.id === byMerchant.id)) {
    return markMismatch(receipt, "商户退款号与支付宝退款号指向不同退款单", byMerchant.paymentId, byMerchant.id, byMerchant.payment.orderId);
  }
  const byProvider = byProviderCandidates.length === 1 ? byProviderCandidates[0]! : null;
  if (byMerchant && byProvider && byMerchant.id !== byProvider.id) {
    return markMismatch(receipt, `商户退款号与支付宝退款号指向不同退款单`, byMerchant.paymentId, byMerchant.id, byMerchant.payment.orderId);
  }
  const refund = byMerchant ?? byProvider;
  if (!refund) return markUnmatched(receipt, "未找到对应退款单");
  if (refund.amount !== receipt.amount) return markMismatch(receipt, `退款金额不一致：系统 ${refund.amount} 分，账单 ${receipt.amount} 分`, refund.paymentId, refund.id, refund.payment.orderId);
  if (refund.channelRefundNo && receipt.providerRefundNo && refund.channelRefundNo !== receipt.providerRefundNo) {
    return markMismatch(receipt, `支付宝退款号不一致：系统 ${refund.channelRefundNo}，账单 ${receipt.providerRefundNo}`, refund.paymentId, refund.id, refund.payment.orderId);
  }
  await markRefundSucceededFromReceipt(refund.refundNo, receipt.amount, receipt.rawPayload as Prisma.InputJsonValue, receipt.providerRefundNo);
  return markMatched(receipt, refund.paymentId, refund.id, refund.payment.orderId);
}

async function markMatched(receipt: Receipt, paymentId: string, refundId: string | null, orderId: string): Promise<Receipt> {
  return db.$transaction(async (tx) => {
    const updated = await tx.receipt.update({ where: { id: receipt.id }, data: {
      matchStatus: "MATCHED", paymentId, refundId, mismatchReason: null,
    } });
    if (receipt.matchStatus !== "MATCHED" || receipt.paymentId !== paymentId || receipt.refundId !== refundId) {
      await tx.paymentEvent.create({ data: {
        aggregateType: "RECEIPT", aggregateId: receipt.id, orderId, paymentId,
        type: "RECEIPT_MATCHED", source: "ALIPAY_BILL", payload: { receiptId: receipt.id, direction: receipt.direction, refundId },
      } });
    }
    return updated;
  });
}

async function markMismatch(receipt: Receipt, reason: string, paymentId: string | null, refundId: string | null, orderId: string | null): Promise<Receipt> {
  return db.$transaction(async (tx) => {
    const updated = await tx.receipt.update({ where: { id: receipt.id }, data: {
      matchStatus: "MISMATCH", paymentId, refundId, mismatchReason: reason,
    } });
    if (receipt.matchStatus !== "MISMATCH" || receipt.mismatchReason !== reason) {
      await tx.paymentEvent.create({ data: {
        aggregateType: "RECEIPT", aggregateId: receipt.id, orderId, paymentId,
        type: "RECEIPT_MISMATCH", source: "ALIPAY_BILL", payload: { receiptId: receipt.id, direction: receipt.direction, reason, refundId },
      } });
    }
    return updated;
  });
}

function markUnmatched(receipt: Receipt, reason: string): Promise<Receipt> {
  return db.receipt.update({ where: { id: receipt.id }, data: {
    matchStatus: "UNMATCHED", paymentId: null, refundId: null, mismatchReason: reason,
  } });
}

function parseStatementDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new AppError("INVALID_STATEMENT_DATE", "账单日期不合法", 422);
  return date;
}
