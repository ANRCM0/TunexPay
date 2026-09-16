import { Prisma, type Receipt, type ReceiptMatchMode } from "@prisma/client";
import { db } from "../db.js";
import { sha256, stableJson } from "../lib/crypto.js";
import { AppError, errorMessage } from "../lib/errors.js";
import {
  extractReceiptReference,
  isWithinReceiptWindow,
  normalizeReceiptFlow,
  receiptFlowRecords,
  shanghaiStatementDate,
  type NormalizedReceiptFlow,
} from "../lib/receipt-flow.js";
import { markPaymentSucceeded } from "./payment-service.js";
import { openPaymentException } from "./payment-exception-service.js";
import { ALIPAY_BILL_ACCOUNT_ID } from "./receipt-reservation-service.js";

const FLOW_LOCK_MS = 60_000;

type PaymentWithOrder = Prisma.PaymentGetPayload<{ include: { order: true } }>;
type MatchChoice =
  | { kind: "MATCH"; payment: PaymentWithOrder; mode: ReceiptMatchMode }
  | { kind: "UNMATCHED"; reason: string }
  | { kind: "MISMATCH"; reason: string; payment?: PaymentWithOrder; ambiguousPaymentNos?: string[]; stateConflict?: boolean };

export type ReceiptFlowOutcome = {
  receiptId: string;
  providerTradeNo: string | null;
  status: string;
  paymentNo: string | null;
  duplicate: boolean;
  reason: string | null;
};

export async function ingestAlipayBillFlows(input: unknown): Promise<ReceiptFlowOutcome[]> {
  const records = receiptFlowRecords(input);
  if (records.length > 100) throw new AppError("TOO_MANY_RECEIPT_FLOWS", "单次最多提交 100 条流水", 422);
  const outcomes: ReceiptFlowOutcome[] = [];
  for (const record of records) outcomes.push(await ingestAlipayBillFlow(normalizeReceiptFlow(record)));
  return outcomes;
}

export async function rematchAlipayBillReceipt(id: string): Promise<Receipt> {
  const receipt = await db.receipt.findUnique({ where: { id } });
  if (!receipt || receipt.provider !== "ALIPAY_BILL") throw new AppError("RECEIPT_NOT_FOUND", "账单收款流水不存在", 404);
  if (receipt.matchStatus === "MATCHED") return receipt;
  await db.receipt.update({ where: { id }, data: { matchStatus: "UNMATCHED", lockedUntil: null } });
  await ingestAlipayBillFlow(normalizeReceiptFlow(receipt.rawPayload as Record<string, unknown>));
  return db.receipt.findUniqueOrThrow({ where: { id } });
}

export async function recoverStaleAlipayBillFlows(limit = 20): Promise<{ found: number; matched: number; failed: number }> {
  const stale = await db.receipt.findMany({
    where: { provider: "ALIPAY_BILL", matchStatus: "PROCESSING", lockedUntil: { lte: new Date() } },
    orderBy: [{ lockedUntil: "asc" }, { id: "asc" }],
    take: limit,
  });
  const summary = { found: stale.length, matched: 0, failed: 0 };
  for (const receipt of stale) {
    try {
      const result = await ingestAlipayBillFlow(normalizeReceiptFlow(receipt.rawPayload as Record<string, unknown>));
      if (result.status === "MATCHED") summary.matched += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

async function ingestAlipayBillFlow(flow: NormalizedReceiptFlow): Promise<ReceiptFlowOutcome> {
  const fingerprint = sha256(stableJson({
    provider: "ALIPAY_BILL",
    accountKey: ALIPAY_BILL_ACCOUNT_ID,
    providerTradeNo: flow.providerTradeNo,
  }));
  let receipt: Receipt;
  let duplicate = false;
  try {
    receipt = await db.receipt.create({ data: {
      provider: "ALIPAY_BILL",
      statementDate: shanghaiStatementDate(flow.paidAt),
      direction: "INCOME",
      providerTradeNo: flow.providerTradeNo,
      merchantOrderNo: flow.merchantOrderNo,
      amount: flow.amount,
      occurredAt: flow.paidAt,
      fingerprint,
      accountKey: ALIPAY_BILL_ACCOUNT_ID,
      remark: flow.remark,
      rawPayload: flow.raw as Prisma.InputJsonValue,
    } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    duplicate = true;
    receipt = await db.receipt.findUniqueOrThrow({ where: { fingerprint } });
  }

  if (["MATCHED", "MISMATCH", "IGNORED"].includes(receipt.matchStatus)) return outcome(receipt, duplicate);
  const now = new Date();
  const claimed = await db.receipt.updateMany({
    where: {
      id: receipt.id,
      OR: [
        { matchStatus: "UNMATCHED" },
        { matchStatus: "PROCESSING", lockedUntil: { lte: now } },
      ],
    },
    data: { matchStatus: "PROCESSING", lockedUntil: new Date(now.getTime() + FLOW_LOCK_MS), mismatchReason: null },
  });
  if (claimed.count === 0) return outcome(await db.receipt.findUniqueOrThrow({ where: { id: receipt.id } }), duplicate);

  try {
    const choice = await locatePayment(flow);
    if (choice.kind === "UNMATCHED") return outcome(await markUnmatched(receipt.id, choice.reason), duplicate);
    if (choice.kind === "MISMATCH") {
      const updated = await markMismatch(receipt.id, choice.reason, choice.payment ?? null, choice.ambiguousPaymentNos, choice.stateConflict);
      return outcome(updated, duplicate);
    }
    const payment = choice.payment;
    if (payment.receiptMatchMode === "REMARK" && extractReceiptReference(flow.remark) !== payment.receiptMatchReference) {
      return outcome(await markMismatch(receipt.id, "备注模式必须填写唯一且正确的付款备注，拒绝按金额或其他标识替代", payment), duplicate);
    }
    if (payment.channelAmount !== flow.amount) {
      return outcome(await markMismatch(
        receipt.id,
        `实收金额不一致：应收 ${payment.channelAmount} 分，流水 ${flow.amount} 分`,
        payment,
      ), duplicate);
    }
    if (!isWithinReceiptWindow(flow.paidAt, payment.receiptValidFrom, payment.receiptValidUntil)) {
      return outcome(await markMismatch(receipt.id, "流水支付时间不在支付单识别有效期内", payment), duplicate);
    }
    if (payment.channelTradeNo && payment.channelTradeNo !== flow.providerTradeNo) {
      return outcome(await markMismatch(
        receipt.id,
        `支付单已绑定其他支付宝交易号 ${payment.channelTradeNo}`,
        payment,
        undefined,
        true,
      ), duplicate);
    }

    await markPaymentSucceeded({
      eventKey: `receipt:${fingerprint}`,
      paymentNo: payment.paymentNo,
      status: "SUCCESS",
      amount: payment.amount,
      receivedAmount: flow.amount,
      channelTradeNo: flow.providerTradeNo,
      paidAt: flow.paidAt,
      raw: flow.raw as Prisma.InputJsonValue,
    }, "ALIPAY_BILL_WATCHER");
    const matched = await db.$transaction(async (tx) => {
      const updated = await tx.receipt.update({ where: { id: receipt.id }, data: {
        matchStatus: "MATCHED",
        matchMode: choice.mode,
        paymentId: payment.id,
        mismatchReason: null,
        lockedUntil: null,
      } });
      await tx.paymentEvent.create({ data: {
        aggregateType: "RECEIPT",
        aggregateId: receipt.id,
        orderId: payment.orderId,
        paymentId: payment.id,
        type: "RECEIPT_MATCHED",
        source: "ALIPAY_BILL_WATCHER",
        payload: { providerTradeNo: flow.providerTradeNo, amount: flow.amount, matchMode: choice.mode },
      } });
      const resolved = await tx.paymentException.updateMany({
        where: {
          subjectType: "RECEIPT",
          subjectId: receipt.id,
          status: { in: ["OPEN", "PROCESSING"] },
        },
        data: {
          status: "RESOLVED",
          resolution: "流水已重新匹配到唯一支付单",
          resolutionRef: payment.paymentNo,
          resolvedAt: new Date(),
        },
      });
      if (resolved.count > 0) {
        await tx.paymentEvent.create({ data: {
          aggregateType: "RECEIPT",
          aggregateId: receipt.id,
          orderId: payment.orderId,
          paymentId: payment.id,
          type: "PAYMENT_EXCEPTION_RESOLVED",
          source: "ALIPAY_BILL_WATCHER",
          payload: { resolution: "流水已重新匹配到唯一支付单", paymentNo: payment.paymentNo },
        } });
      }
      return updated;
    });
    return outcome(matched, duplicate, payment.paymentNo);
  } catch (error) {
    if (error instanceof AppError) {
      const failed = await markMismatch(receipt.id, error.message, null, undefined, true);
      return outcome(failed, duplicate);
    }
    await db.receipt.update({ where: { id: receipt.id }, data: {
      matchStatus: "PROCESSING",
      lockedUntil: new Date(Date.now() + FLOW_LOCK_MS),
      mismatchReason: errorMessage(error).slice(0, 500),
    } });
    throw error;
  }
}

async function locatePayment(flow: NormalizedReceiptFlow): Promise<MatchChoice> {
  const [direct, byTrade] = await Promise.all([
    flow.merchantOrderNo ? db.payment.findMany({
      where: { channel: "ALIPAY_BILL", OR: [{ paymentNo: flow.merchantOrderNo }, { channelOrderNo: flow.merchantOrderNo }] },
      include: { order: true },
      take: 3,
    }) : Promise.resolve([] as PaymentWithOrder[]),
    db.payment.findUnique({ where: { channelTradeNo: flow.providerTradeNo }, include: { order: true } }),
  ]);
  if (direct.length > 1) return ambiguous("商户订单号对应多笔账单支付单", direct);
  if (byTrade) {
    if (byTrade.channel !== "ALIPAY_BILL") {
      return { kind: "MISMATCH", reason: `支付宝交易号已被 ${byTrade.channel} 支付单 ${byTrade.paymentNo} 占用`, payment: byTrade, stateConflict: true };
    }
    if (direct[0] && direct[0].id !== byTrade.id) {
      return {
        kind: "MISMATCH",
        reason: `商户订单号与支付宝交易号分别指向 ${direct[0].paymentNo} 和 ${byTrade.paymentNo}`,
        payment: direct[0],
        stateConflict: true,
      };
    }
  }
  if (direct[0] || byTrade) return { kind: "MATCH", payment: direct[0] ?? byTrade!, mode: "DIRECT" };

  const reference = extractReceiptReference(flow.remark);
  if (!reference && /(?:^|[^A-Z0-9])TX[A-Z0-9]{10}(?=$|[^A-Z0-9])/i.test(flow.remark ?? "")) {
    return { kind: "MISMATCH", reason: "付款备注包含多个识别码，拒绝自动匹配" };
  }
  if (reference) {
    const referenced = await db.payment.findMany({
      where: { channel: "ALIPAY_BILL", receiptMatchReference: reference },
      include: { order: true },
      take: 3,
    });
    const byRemark = referenced.filter(payment => payment.channelAmount === flow.amount
      && isWithinReceiptWindow(flow.paidAt, payment.receiptValidFrom, payment.receiptValidUntil));
    if (byRemark.length > 1) return ambiguous(`付款备注 ${reference} 对应多笔支付单`, byRemark);
    if (byRemark[0]) return { kind: "MATCH", payment: byRemark[0], mode: "REMARK" };
    return {
      kind: "MISMATCH",
      reason: referenced.length ? `付款备注 ${reference} 对应的支付单金额或有效期不匹配` : `付款备注 ${reference} 未对应任何支付单`,
      payment: referenced[0],
    };
  }

  const byAmount = await db.payment.findMany({
    where: {
      channel: "ALIPAY_BILL",
      channelAmount: flow.amount,
      receiptMatchMode: "AMOUNT",
      receiptValidFrom: { lte: flow.paidAt },
      receiptValidUntil: { gte: flow.paidAt },
    },
    include: { order: true },
    orderBy: { receiptValidFrom: "desc" },
    take: 3,
  });
  if (byAmount.length > 1) return ambiguous(`金额 ${flow.amount} 分在有效期内对应多笔支付单，拒绝猜测`, byAmount);
  if (byAmount[0]) return { kind: "MATCH", payment: byAmount[0], mode: "AMOUNT" };
  return { kind: "UNMATCHED", reason: "未按交易号、备注或有效期内金额找到支付单" };
}

function ambiguous(reason: string, payments: PaymentWithOrder[]): MatchChoice {
  return { kind: "MISMATCH", reason, ambiguousPaymentNos: payments.map(payment => payment.paymentNo) };
}

async function markUnmatched(receiptId: string, reason: string): Promise<Receipt> {
  return db.receipt.update({ where: { id: receiptId }, data: {
    matchStatus: "UNMATCHED",
    mismatchReason: reason.slice(0, 500),
    paymentId: null,
    matchMode: null,
    lockedUntil: null,
  } });
}

async function markMismatch(
  receiptId: string,
  reason: string,
  payment: PaymentWithOrder | null,
  ambiguousPaymentNos?: string[],
  stateConflict = false,
): Promise<Receipt> {
  return db.$transaction(async (tx) => {
    const updated = await tx.receipt.update({ where: { id: receiptId }, data: {
      matchStatus: "MISMATCH",
      mismatchReason: reason.slice(0, 500),
      paymentId: payment?.id ?? null,
      lockedUntil: null,
    } });
    if (stateConflict || ambiguousPaymentNos) {
      await openPaymentException(tx, {
        type: stateConflict ? "PAYMENT_STATE_CONFLICT" : "RECEIPT_AMBIGUOUS",
        severity: stateConflict ? "CRITICAL" : "HIGH",
        subjectType: "RECEIPT",
        subjectId: receiptId,
        orderId: payment?.orderId,
        paymentId: payment?.id,
        source: "ALIPAY_BILL_WATCHER",
        summary: reason.slice(0, 300),
        detail: { receiptId, paymentNo: payment?.paymentNo ?? null, candidates: ambiguousPaymentNos ?? [] },
      });
    }
    if (payment) {
      await tx.paymentEvent.create({ data: {
        aggregateType: "RECEIPT",
        aggregateId: receiptId,
        orderId: payment.orderId,
        paymentId: payment.id,
        type: "RECEIPT_MISMATCH",
        source: "ALIPAY_BILL_WATCHER",
        payload: { reason },
      } });
    }
    return updated;
  });
}

function outcome(receipt: Receipt, duplicate: boolean, paymentNo?: string): ReceiptFlowOutcome {
  return {
    receiptId: receipt.id,
    providerTradeNo: receipt.providerTradeNo,
    status: receipt.matchStatus,
    paymentNo: paymentNo ?? null,
    duplicate,
    reason: receipt.mismatchReason,
  };
}
