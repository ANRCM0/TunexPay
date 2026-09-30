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

import { paymentChannelScope } from "../lib/channel-scope.js";

const FLOW_LOCK_MS = 60_000;
/**
 * 单批流水的并发上限。每条流水要跑 8~12 条 SQL（指纹去重 → 租约认领 → 定位支付单 →
 * markPaymentSucceeded 事务 → 回执更新事务），串行处理 100 条会把整批的墙钟时间压成
 * 100 倍的往返延迟。这里取 4 是保守值：既能利用多个连接并行等待数据库往返，又不会让
 * 单个 Worker 一次性占满连接池或把行锁竞争放大。不引入新依赖（不引 p-limit 之类）。
 */
const FLOW_CONCURRENCY = 4;

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

export async function ingestAlipayBillFlows(input: unknown, accountId = ALIPAY_BILL_ACCOUNT_ID): Promise<ReceiptFlowOutcome[]> {
  const records = receiptFlowRecords(input);
  if (records.length > 100) throw new AppError("TOO_MANY_RECEIPT_FLOWS", "单次最多提交 100 条流水", 422);
  // 归一化留在每条流水自己的处理步骤里，与原来的逐条循环一致：某条流水格式不合法时，排在它
  // 前面的合法流水已经入库，不会因为一条坏数据把整批变成「什么都没发生」而卡住调用方重试。
  //
  // 与串行版本相比，并发会让「失败之前的那些流水」推进得更多（串行版本在一批里遇到第一条
  // 失败时，后面的记录根本不会碰；并发版本已经有一批流水在飞，它们会各自跑到自己的终态）。
  // 这是安全的：整批重放时，回执指纹 fingerprint 的数据库唯一约束保证同一条流水只会有一行
  // 回执，PROCESSING 租约（matchStatus + lockedUntil 的条件更新）保证同一行回执同一时刻只有
  // 一个执行者，markPaymentSucceeded 也按 eventKey 幂等。因此「多推进了」只会表现为重放时命中
  // duplicate / 租约未过期而直接返回既有回执，不会产生重复回执、重复支付成功事件或重复异常。
  return runBounded(records, FLOW_CONCURRENCY, record => ingestAlipayBillFlow(normalizeReceiptFlow(record), accountId));
}

/**
 * 有界并发工作池，严格保持「结果顺序 === 输入顺序」，并且失败语义贴近原来的串行版本。
 *
 * 1) 并发上限：至多 `limit` 个 task 同时在飞，不会因为一批 100 条就打出 100 路并发。
 * 2) 顺序：每条流水的结果写入它自己的下标 `results[index]`，与完成先后无关，因此调用方仍然
 *    可以按输入顺序读 outcomes；不会出现完成早的流水结果跑到前面去。
 *    （为了做到这一点，工作池按下标递增领取任务，而不是用"谁先空出来谁领下一条"的
 *    自由队列 —— 后者会让慢流水拖住后面的下标，但对输出顺序没有影响；按下标领取同时
 *    保证了不会跳过任何一条。）
 * 3) 失败收敛：一旦某个 task 抛错，就记下第一个错误并让所有工作协程停止领取新任务，
 *    等在飞的 task 各自结算完毕后，由发起方抛出第一个错误。不用 Promise.allSettled 静默
 *    吞错，也不会有悬空的 rejection（每个在飞任务都被某个协程 await 过）。
 */
async function runBounded<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index]!, index);
      } catch (error) {
        // 只保留第一个错误，后续（在飞任务）的失败不再覆盖它；同时置位失败标记，
        // 让其余协程在下一轮循环条件处退出，不再领取新记录。
        failure ??= { error };
      }
    }
  });
  await Promise.all(workers);
  if (failure) {
    const { error } = failure;
    throw error;
  }
  return results;
}

export async function rematchAlipayBillReceipt(id: string): Promise<Receipt> {
  const receipt = await db.receipt.findUnique({ where: { id } });
  if (!receipt || receipt.provider !== "ALIPAY_BILL") throw new AppError("RECEIPT_NOT_FOUND", "账单收款流水不存在", 404);
  if (receipt.matchStatus === "MATCHED") return receipt;
  await db.receipt.update({ where: { id }, data: { matchStatus: "UNMATCHED", lockedUntil: null } });
  await ingestAlipayBillFlow(normalizeReceiptFlow(receipt.rawPayload as Record<string, unknown>), receipt.accountKey || ALIPAY_BILL_ACCOUNT_ID);
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
      const result = await ingestAlipayBillFlow(normalizeReceiptFlow(receipt.rawPayload as Record<string, unknown>), receipt.accountKey || ALIPAY_BILL_ACCOUNT_ID);
      if (result.status === "MATCHED") summary.matched += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

async function ingestAlipayBillFlow(flow: NormalizedReceiptFlow, accountId: string): Promise<ReceiptFlowOutcome> {
  const fingerprint = sha256(stableJson({
    provider: "ALIPAY_BILL",
    accountKey: accountId,
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
      accountKey: accountId,
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
    const choice = await locatePayment(flow, accountId);
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

async function locatePayment(flow: NormalizedReceiptFlow, accountId: string): Promise<MatchChoice> {
  const [direct, byTrade] = await Promise.all([
    flow.merchantOrderNo ? db.payment.findMany({
      where: { ...paymentChannelScope(accountId, "ALIPAY_BILL"), OR: [{ paymentNo: flow.merchantOrderNo }, { channelOrderNo: flow.merchantOrderNo }] },
      include: { order: true },
      take: 3,
    }) : Promise.resolve([] as PaymentWithOrder[]),
    db.payment.findUnique({ where: { channelTradeNo: flow.providerTradeNo }, include: { order: true } }),
  ]);
  if (direct.length > 1) return ambiguous("商户订单号对应多笔账单支付单", direct);
  if (byTrade) {
    if (byTrade.channel !== "ALIPAY_BILL" || (byTrade.channelId || ALIPAY_BILL_ACCOUNT_ID) !== accountId) {
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
      where: { ...paymentChannelScope(accountId, "ALIPAY_BILL"), receiptMatchReference: reference },
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
      ...paymentChannelScope(accountId, "ALIPAY_BILL"),
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
