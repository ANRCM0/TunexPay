import { randomUUID } from "node:crypto";
import { AlipayChannel } from "../channels/alipay.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { sha256 } from "../lib/crypto.js";
import { alipayTime, accountLogPage, collectorWindow, paymentFlowFromAccountLog } from "../lib/alipay-account-log.js";
import { log } from "../lib/logger.js";
import { normalizeReceiptFlow } from "../lib/receipt-flow.js";
import { ingestAlipayBillFlows } from "./receipt-flow-service.js";
import { ALIPAY_BILL_ACCOUNT_ID } from "./receipt-reservation-service.js";

const LEASE_MS = 60_000;
const PAGE_SIZE = 100;

export async function runAlipayBillCollector(): Promise<void> {
  const cfg = config();
  if (!cfg.ALIPAY_BILL_COLLECTOR_ENABLED) return;
  const now = new Date();
  const binding = sha256(JSON.stringify([cfg.ALIPAY_APP_ID, cfg.ALIPAY_BILL_USER_ID, cfg.ALIPAY_GATEWAY, cfg.ALIPAY_BILL_QR_CONTENT]));
  const state = await db.billCollectorState.upsert({
    where: { id: ALIPAY_BILL_ACCOUNT_ID },
    create: { id: ALIPAY_BILL_ACCOUNT_ID, binding, cursorAt: new Date(now.getTime() - cfg.ALIPAY_BILL_LOOKBACK_SECONDS * 1000) },
    update: {},
  });
  if (state.binding !== binding) {
    await db.billCollectorState.update({ where: { id: state.id }, data: { heartbeatAt: now, lastError: "ACCOUNT_BINDING_CHANGED: 账号/网关/收款码已变更，需人工核对历史订单后迁移账号", consecutiveErrors: 1 } });
    return;
  }
  const owner = randomUUID();
  await db.billCollectorState.update({ where: { id: state.id }, data: { heartbeatAt: now } });
  const claimed = await db.billCollectorState.updateMany({
    where: { id: state.id, nextRunAt: { lte: now }, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
    data: { leaseOwner: owner, lockedUntil: new Date(now.getTime() + LEASE_MS), heartbeatAt: now },
  });
  if (!claimed.count) return;
  const owned = { id: state.id, leaseOwner: owner };
  try {
    let current = await db.billCollectorState.findUniqueOrThrow({ where: { id: state.id } });
    if (!current.windowStart || !current.windowEnd) {
      const window = collectorWindow(current.cursorAt, now, cfg.ALIPAY_BILL_OVERLAP_SECONDS, cfg.ALIPAY_BILL_LAG_SECONDS);
      if (window.end <= current.cursorAt) return;
      await db.billCollectorState.updateMany({ where: owned, data: { windowStart: window.start, windowEnd: window.end, nextPage: 1 } });
      current = await db.billCollectorState.findUniqueOrThrow({ where: { id: state.id } });
    }
    const channel = new AlipayChannel();
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
      for (const record of page.records) {
        const flow = paymentFlowFromAccountLog(record);
        if (flow) {
          const paidAt = normalizeReceiptFlow(flow).paidAt;
          if (paidAt < current.windowStart! || paidAt >= current.windowEnd!) throw new Error("ALIPAY_BILL_OUTSIDE_QUERY_WINDOW");
          await ingestAlipayBillFlows({ record: flow });
        }
      }
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
    await db.billCollectorState.updateMany({ where: { id: state.id, leaseOwner: null, nextRunAt: { lte: now } }, data: { nextRunAt: new Date(Date.now() + cfg.ALIPAY_BILL_POLL_SECONDS * 1000) } });
  }
}

export async function alipayBillCollectorStatus() {
  const cfg = config();
  if (!cfg.ALIPAY_BILL_COLLECTOR_ENABLED) return { enabled: false, status: "DISABLED" };
  const state = await db.billCollectorState.findUnique({ where: { id: ALIPAY_BILL_ACCOUNT_ID } });
  const stale = !state?.heartbeatAt || Date.now() - state.heartbeatAt.getTime() > Math.max(90, cfg.ALIPAY_BILL_POLL_SECONDS * 3) * 1000;
  return { enabled: true, status: stale ? "OFFLINE" : state?.lastError ? "ERROR" : state?.lastSuccessAt ? "RUNNING" : "STARTING", cursorAt: state?.cursorAt, nextPage: state?.nextPage, heartbeatAt: state?.heartbeatAt, lastSuccessAt: state?.lastSuccessAt, lastError: state?.lastError, nextRunAt: state?.nextRunAt, consecutiveErrors: state?.consecutiveErrors, processedRecords: state?.processedRecords };
}
