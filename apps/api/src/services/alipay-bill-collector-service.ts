import { randomUUID } from "node:crypto";
import { AlipayChannel } from "../channels/alipay.js";
import { billRuntimeConfig } from "./bill-settings-service.js";
import { db } from "../db.js";
import { sha256 } from "../lib/crypto.js";
import { alipayTime, accountLogPage, collectorWindow, paymentFlowFromAccountLog } from "../lib/alipay-account-log.js";
import { log } from "../lib/logger.js";
import { normalizeReceiptFlow } from "../lib/receipt-flow.js";
import { ingestAlipayBillFlows } from "./receipt-flow-service.js";
import { ALIPAY_BILL_ACCOUNT_ID } from "./receipt-reservation-service.js";

import { paymentChannelScope } from "../lib/channel-scope.js";

const LEASE_MS = 60_000;
const PAGE_SIZE = 100;
/** 空闲时的心跳刷新间隔：状态页在无需求时显示 IDLE，不读心跳，没必要每一跳都写一次。 */
const IDLE_HEARTBEAT_MS = 30_000;

// Keep a bounded tail for ledger entries delayed beyond QR expiry.
async function collectionDemand(client: Pick<typeof db, "payment">, now: Date, overlap: number, lag: number, accountId: string) {
  return client.payment.findFirst({
    where: {
      ...paymentChannelScope(accountId, "ALIPAY_BILL"), status: { not: "SUCCESS" },
      receiptValidFrom: { lte: now },
      receiptValidUntil: { gte: new Date(now.getTime() - Math.max(300, overlap + lag) * 1000) },
    },
    orderBy: { receiptValidFrom: "asc" }, select: { receiptValidFrom: true },
  });
}

export async function runAlipayBillCollector(accountId = ALIPAY_BILL_ACCOUNT_ID): Promise<void> {
  const result = await db.$transaction(async (tx) => {
    // 这里只需要一个配置快照，不需要在共享的配置行上取写锁：锁在提交时就释放，而真正的采集
    // 发生在事务之外，中途的配置变更由下面按 billRevision 的复查负责。每一跳对
    // bill_channel_settings 取一次 FOR UPDATE 只会给面板保存配置制造无谓的锁等待。
    const cfg = await billRuntimeConfig(tx, false, accountId);
    const now = new Date();
    if (!cfg.ALIPAY_BILL_COLLECTOR_ENABLED) {
      // 采集关闭时把下次检查推后（条件更新：已经推过的一跳不会再写），否则每一跳都要重新
      // 读一次配置。面板保存配置会把 nextRunAt 拉回当前时间，所以重新打开采集仍会被
      // 紧接着的一跳发现，不会因为这里的退避而漏掉。
      await tx.billCollectorState.updateMany({
        where: { id: accountId, nextRunAt: { lte: now } },
        data: { nextRunAt: new Date(now.getTime() + Math.max(cfg.ALIPAY_BILL_POLL_SECONDS, 30) * 1_000) },
      });
      return null;
    }
    const demand = await collectionDemand(tx, now, cfg.ALIPAY_BILL_OVERLAP_SECONDS, cfg.ALIPAY_BILL_LAG_SECONDS, accountId);
    if (!demand) {
      // 无待收流水时状态页显示 IDLE、不读心跳；因此只在心跳确实过期时才刷新，
      // 不再每一跳都对同一行做一次空写。
      await tx.billCollectorState.updateMany({
        where: { id: accountId, OR: [{ heartbeatAt: null }, { heartbeatAt: { lte: new Date(now.getTime() - IDLE_HEARTBEAT_MS) } }] },
        data: { heartbeatAt: now },
      });
      return null;
    }
    const binding = sha256(JSON.stringify([cfg.ALIPAY_APP_ID, cfg.ALIPAY_BILL_USER_ID, cfg.ALIPAY_GATEWAY, cfg.ALIPAY_BILL_QR_CONTENT]));
    const state = await tx.billCollectorState.upsert({
      where: { id: accountId },
      create: { id: accountId, binding, cursorAt: demand.receiptValidFrom! },
      update: {},
    });
    if (state.binding !== binding) {
      await tx.billCollectorState.update({ where: { id: state.id }, data: { heartbeatAt: now, lastError: "ACCOUNT_BINDING_CHANGED: 账号/网关/收款码已变更，需人工核对历史订单后迁移账号", consecutiveErrors: 1 } });
      return null;
    }
    const owner = randomUUID();
    await tx.billCollectorState.update({ where: { id: state.id }, data: { heartbeatAt: now } });
    const claimed = await tx.billCollectorState.updateMany({
      where: { id: state.id, nextRunAt: { lte: now }, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
      data: { leaseOwner: owner, lockedUntil: new Date(now.getTime() + LEASE_MS), heartbeatAt: now },
    });
    return claimed.count ? { cfg, state, owner, now, demand } : null;
  });
  if (!result) return;
  const { cfg, state, owner, now, demand } = result;
  const owned = { id: state.id, leaseOwner: owner };
  try {
    let current = await db.billCollectorState.findUniqueOrThrow({ where: { id: state.id } });
    if (!current.windowStart || !current.windowEnd) {
      // Skip idle history; unfinished pages/windows remain durable and replayable.
      if (demand.receiptValidFrom && current.cursorAt < demand.receiptValidFrom) {
        await db.billCollectorState.updateMany({ where: owned, data: { cursorAt: demand.receiptValidFrom } });
        current.cursorAt = demand.receiptValidFrom;
      }
      const window = collectorWindow(current.cursorAt, now, cfg.ALIPAY_BILL_OVERLAP_SECONDS, cfg.ALIPAY_BILL_LAG_SECONDS);
      if (window.end <= current.cursorAt) return;
      await db.billCollectorState.updateMany({ where: owned, data: { windowStart: window.start, windowEnd: window.end, nextPage: 1 } });
      current = await db.billCollectorState.findUniqueOrThrow({ where: { id: state.id } });
    }
    const channel = new AlipayChannel(cfg);
    for (let step = 0; step < 5; step++) {
      const renewed = await db.billCollectorState.updateMany({ where: { ...owned, lockedUntil: { gt: new Date() } }, data: { lockedUntil: new Date(Date.now() + LEASE_MS), heartbeatAt: new Date() } });
      if (!renewed.count) throw new Error("ALIPAY_BILL_LEASE_LOST");
      const pageNo = current.nextPage;
      const response = await channel.queryAccountLogs({
        bill_user_id: cfg.ALIPAY_BILL_USER_ID,
        start_time: alipayTime(current.windowStart!), end_time: alipayTime(current.windowEnd!),
        page_no: pageNo, page_size: PAGE_SIZE,
      });
      const page = accountLogPage(response, pageNo, PAGE_SIZE);
      // 先整页校验、再整页批量投递（原来是"逐条校验 + 逐条投递"交替进行）。
      // 顺序变化只影响"发现越界流水之前已经投递了多少条"：现在一页里只要有任意一条
      // paidAt 落在 [windowStart, windowEnd) 之外，这一页一条都不会投递，而不是投递到那条
      // 越界记录为止的前半页。这是安全的，因为页在崩溃/失败后会被原样重放：回执指纹的唯一
      // 约束与支付核心（eventKey 幂等 + 支付单状态机）保证重放不会产生重复回执或重复成功。
      // 校验仍逐条进行，语义不变（越界即抛 ALIPAY_BILL_OUTSIDE_QUERY_WINDOW，游标不前进）。
      const flows: Record<string, unknown>[] = [];
      for (const record of page.records) {
        const flow = paymentFlowFromAccountLog(record);
        if (!flow) continue;
        const paidAt = normalizeReceiptFlow(flow).paidAt;
        if (paidAt < current.windowStart! || paidAt >= current.windowEnd!) throw new Error("ALIPAY_BILL_OUTSIDE_QUERY_WINDOW");
        flows.push(flow);
      }
      // PAGE_SIZE 与 ingestAlipayBillFlows 的 100 条上限一致，因此整页可以一次投递；
      // 服务内部的批内有界并发（FLOW_CONCURRENCY）负责把这一页真正并行起来。
      if (flows.length) await ingestAlipayBillFlows({ records: flows }, accountId);
      // Receipts are durable before advancing the page. A crash replays this page;
      // receipt fingerprint + the payment core make replay idempotent.
      const committed = await db.billCollectorState.updateMany({
        where: { ...owned, lockedUntil: { gt: new Date() } },
        data: {
          ...(page.complete ? { cursorAt: current.windowEnd!, windowStart: null, windowEnd: null, nextPage: 1 } : { nextPage: pageNo + 1 }),
          lastSuccessAt: new Date(), lastError: null, consecutiveErrors: 0,
          processedRecords: { increment: page.records.length },
        },
      });
      if (!committed.count) throw new Error("ALIPAY_BILL_LEASE_LOST");
      if (page.complete) break;
      if ((await billRuntimeConfig(db, false, accountId)).billRevision !== cfg.billRevision) break;
      if (!await collectionDemand(db, new Date(), cfg.ALIPAY_BILL_OVERLAP_SECONDS, cfg.ALIPAY_BILL_LAG_SECONDS, accountId)) break;
      current = await db.billCollectorState.findUniqueOrThrow({ where: { id: state.id } });
    }
  } catch (error) {
    // Avoid provider payloads/private keys/user remarks in logs or status errors.
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.message.match(/^ALIPAY_BILL_[A-Z_]+/)?.[0] || "COLLECTION_FAILED" : "COLLECTION_FAILED";
    const failures = await db.billCollectorState.findUniqueOrThrow({ where: { id: state.id } });
    const backoff = Math.min(300, cfg.ALIPAY_BILL_POLL_SECONDS * 2 ** Math.min(failures.consecutiveErrors + 1, 6));
    await db.billCollectorState.updateMany({ where: owned, data: { lastError: code.slice(0, 500), consecutiveErrors: { increment: 1 }, nextRunAt: new Date(Date.now() + backoff * 1000) } });
    log("warn", "alipay_bill.collection_failed", { code });
  } finally {
    await db.billCollectorState.updateMany({ where: owned, data: { leaseOwner: null, lockedUntil: null } });
    await db.billCollectorState.updateMany({ where: { id: state.id, leaseOwner: null, nextRunAt: { lte: now } }, data: { nextRunAt: new Date(Date.now() + (demand ? 1 : cfg.ALIPAY_BILL_POLL_SECONDS) * 1000) } });
  }
}

export async function alipayBillCollectorStatus(accountId = ALIPAY_BILL_ACCOUNT_ID) {
  const cfg = await billRuntimeConfig(db, false, accountId);
  if (!cfg.ALIPAY_BILL_COLLECTOR_ENABLED) return { enabled: false, status: "DISABLED" };
  const state = await db.billCollectorState.findUnique({ where: { id: accountId } });
  const demand = await collectionDemand(db, new Date(), cfg.ALIPAY_BILL_OVERLAP_SECONDS, cfg.ALIPAY_BILL_LAG_SECONDS, accountId);
  const stale = !state?.heartbeatAt || Date.now() - state.heartbeatAt.getTime() > Math.max(90, cfg.ALIPAY_BILL_POLL_SECONDS * 3) * 1000;
  return { enabled: true, status: !demand ? "IDLE" : stale ? "OFFLINE" : state?.lastError ? "ERROR" : state?.lastSuccessAt ? "RUNNING" : "STARTING", cursorAt: state?.cursorAt, nextPage: state?.nextPage, heartbeatAt: state?.heartbeatAt, lastSuccessAt: state?.lastSuccessAt, lastError: state?.lastError, nextRunAt: state?.nextRunAt, consecutiveErrors: state?.consecutiveErrors, processedRecords: state?.processedRecords };
}

export async function runAllBillCollectors(): Promise<void> {
  // 只为「真实存在的通道」跑采集，不再无条件带上历史默认账号：
  // 默认通道已不再自动创建，对新装环境来说那个 id 根本不存在，每跳都为它开一次事务是纯浪费。
  // 注意这里**故意不过滤 archivedAt**：通道归档只阻断新支付，如果它还有在途的账单收款单，
  // 采集器必须继续把到账流水匹配上，否则那笔钱永远确认不了。
  const rows = await db.channelInstance.findMany({ where: { plugin: "ALIPAY_BILL" }, select: { id: true } });
  const ids = new Set(rows.map(row => row.id));
  await Promise.allSettled([...ids].map(async id => { try { await runAlipayBillCollector(id); } catch { log("error", "alipay_bill.collector_failed", { channelId: id }); } }));
}
