import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 只在内存里复刻 receipt-flow-service 真正依赖到的数据库行为：
// fingerprint 唯一约束（触发 P2002 → 复用已存在回执的去重路径）、租约认领的条件更新
// （matchStatus/lockedUntil）、回执状态写入、paymentEvent 写入。真实 MySQL 的行锁、
// 死锁与锁等待无法在这里验证，那属于有数据库环境下的验收项。
const flowMocks = vi.hoisted(() => ({ db: {} as Record<string, unknown>, succeed: vi.fn(), exception: vi.fn() }));
vi.mock("../db.js", () => ({ db: flowMocks.db }));
vi.mock("../services/payment-service.js", () => ({ markPaymentSucceeded: flowMocks.succeed }));
vi.mock("../services/payment-exception-service.js", () => ({ openPaymentException: flowMocks.exception }));

import { ingestAlipayBillFlows } from "../services/receipt-flow-service.js";
import { sha256, stableJson } from "../lib/crypto.js";

type FakeReceipt = {
  id: string;
  fingerprint: string;
  providerTradeNo: string;
  matchStatus: string;
  lockedUntil: Date | null;
  mismatchReason: string | null;
  matchMode?: string | null;
  paymentId?: string | null;
};

const ACCOUNT = "alipay-bill-default";
/** 与 receipt-flow-service 里的 FLOW_CONCURRENCY 对应，刻意不从实现里导入，避免测试自我印证。 */
const EXPECTED_CONCURRENCY = 4;
const WINDOW = { from: new Date("2026-09-15T00:00:00Z"), until: new Date("2026-09-17T00:00:00Z") };

/** 让出一次事件循环，使已经 resolve 的 promise 回调得以推进。 */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * 并发闸门：每条进入指纹写入的流水都登记一次到达，等到到达数达到 target（= 并发上限）后
 * 一次性放行（之后不再拦截）。这样能确定性地证明并发确实发生，也不需要真的等待墙钟时间；
 * 如果实现退回串行，到达数永远到不了 target，由超时给出明确失败而不是永久挂起。
 */
function gate() {
  let arrived = 0;
  let open = false;
  let release!: () => void;
  const opened = new Promise<void>(resolve => { release = resolve; });
  const guard = new Promise<void>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`CONCURRENCY_NOT_REACHED: 期望同时在飞 ${EXPECTED_CONCURRENCY} 条，实际只有 ${arrived} 条`)),
      2000,
    );
    void opened.then(() => clearTimeout(timer));
  });
  return {
    async pass() {
      if (open) return;
      arrived += 1;
      peakArrived = Math.max(peakArrived, arrived);
      if (arrived >= EXPECTED_CONCURRENCY) {
        open = true;
        release();
      }
      await Promise.race([opened, guard]);
    },
  };
}

function receiptKey(providerTradeNo: string) {
  return sha256(stableJson({ provider: "ALIPAY_BILL", accountKey: ACCOUNT, providerTradeNo }));
}

let receipts: FakeReceipt[] = [];
let receiptSeq = 0;
let events: Record<string, unknown>[] = [];
let inFlight = 0;
let peakInFlight = 0;
let peakArrived = 0;
let createdOrder: string[] = [];
let createCalls = new Map<string, number>();
let currentGate: ReturnType<typeof gate> | undefined;
let failClaimFor: string | undefined;

function findReceipt(where: Record<string, any>): FakeReceipt | undefined {
  if (where.fingerprint) return receipts.find(item => item.fingerprint === where.fingerprint);
  if (where.id) return receipts.find(item => item.id === where.id);
  return undefined;
}

function claimable(receipt: FakeReceipt, where: Record<string, any>): boolean {
  if (where.id !== receipt.id) return false;
  const now = new Date();
  return (where.OR as Record<string, any>[]).some(branch =>
    branch.matchStatus === "UNMATCHED"
      ? receipt.matchStatus === "UNMATCHED"
      : receipt.matchStatus === "PROCESSING" && receipt.lockedUntil !== null && receipt.lockedUntil <= now);
}

function fakePayment(providerTradeNo: string) {
  return {
    id: `payment-${providerTradeNo}`,
    paymentNo: `p-${providerTradeNo}`,
    orderId: `order-${providerTradeNo}`,
    order: { id: `order-${providerTradeNo}` },
    channel: "ALIPAY_BILL",
    channelId: ACCOUNT,
    channelTradeNo: providerTradeNo,
    channelAmount: 1000,
    amount: 1000,
    receiptMatchMode: "AMOUNT",
    receiptMatchReference: null,
    receiptValidFrom: WINDOW.from,
    receiptValidUntil: WINDOW.until,
  };
}

function installFakeDb() {
  const receiptApi = {
    create: async ({ data }: { data: Record<string, any> }) => {
      const tradeNo = String(data.providerTradeNo);
      createCalls.set(tradeNo, (createCalls.get(tradeNo) ?? 0) + 1);
      createdOrder.push(tradeNo);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        if (currentGate) await currentGate.pass();
        if (receipts.some(item => item.fingerprint === data.fingerprint)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`fingerprint`)", { code: "P2002", clientVersion: "6.12.0" });
        }
        const receipt: FakeReceipt = {
          id: `receipt-${++receiptSeq}`,
          fingerprint: String(data.fingerprint),
          providerTradeNo: tradeNo,
          matchStatus: "UNMATCHED",
          lockedUntil: null,
          mismatchReason: null,
        };
        receipts.push(receipt);
        return { ...receipt };
      } finally {
        inFlight -= 1;
      }
    },
    findUniqueOrThrow: async ({ where }: { where: Record<string, any> }) => {
      const found = findReceipt(where);
      if (!found) throw new Error("RECEIPT_NOT_FOUND");
      return { ...found };
    },
    updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      const receipt = receipts.find(item => item.id === where.id);
      if (!receipt) return { count: 0 };
      if (failClaimFor === receipt.providerTradeNo) {
        failClaimFor = undefined;
        throw new Error("SENTINEL_FAILURE");
      }
      if (!claimable(receipt, where)) return { count: 0 };
      Object.assign(receipt, data);
      return { count: 1 };
    },
    update: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      const receipt = receipts.find(item => item.id === where.id);
      if (!receipt) throw new Error("RECEIPT_NOT_FOUND");
      Object.assign(receipt, data);
      return { ...receipt };
    },
  };
  const paymentApi = {
    findMany: async () => [],
    findUnique: async ({ where }: { where: Record<string, any> }) => where.channelTradeNo ? fakePayment(String(where.channelTradeNo)) : null,
  };
  const paymentEventApi = { create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data; } };
  return {
    receipt: receiptApi,
    payment: paymentApi,
    paymentEvent: paymentEventApi,
    $transaction: async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => callback({
      receipt: receiptApi,
      paymentEvent: paymentEventApi,
      paymentException: { updateMany: async () => ({ count: 0 }) },
    }),
  };
}

function flow(tradeNo: string) {
  return { providerTradeNo: tradeNo, amount: 1000, paidAt: "2026-09-16 12:00:00" };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 假库的构造失败必须立刻暴露：db 上缺方法时服务内部会抛错，工作池只会把它记成
  // "某条流水失败"，undefined 结果会把真实原因掩盖掉。
  expect(() => Object.assign(flowMocks.db, installFakeDb())).not.toThrow();
  expect(typeof (flowMocks.db.receipt as { create?: unknown }).create).toBe("function");
  expect(typeof (flowMocks.db.payment as { findUnique?: unknown }).findUnique).toBe("function");
  flowMocks.succeed.mockResolvedValue({});
  flowMocks.exception.mockResolvedValue({});
  receipts = []; receiptSeq = 0; events = []; inFlight = 0; peakInFlight = 0; peakArrived = 0;
  createdOrder = []; createCalls = new Map(); currentGate = undefined; failClaimFor = undefined;
});

describe("ingestAlipayBillFlows bounded concurrency", () => {
  it("并发处理一批流水，但返回数组与输入严格同序一一对应", async () => {
    const tradeNos = Array.from({ length: 10 }, (_, index) => `t${index + 1}`);
    currentGate = gate();

    const outcomes = await ingestAlipayBillFlows({ records: tradeNos.map(flow) }, ACCOUNT);

    expect(outcomes.map(item => item.providerTradeNo)).toEqual(tradeNos);
    expect(outcomes.map(item => item.paymentNo)).toEqual(tradeNos.map(tradeNo => `p-${tradeNo}`));
    expect(outcomes.every(item => item.status === "MATCHED" && item.duplicate === false)).toBe(true);
    // 回执 id 按输入顺序生成，证明结果数组的位置与输入位置一一对应，而不是按完成先后排列。
    expect(outcomes.map(item => item.receiptId)).toEqual(tradeNos.map((_, index) => `receipt-${index + 1}`));
    expect(events.map(event => (event.payload as Record<string, unknown>).providerTradeNo)).toEqual(tradeNos);
  });

  it("并发确实发生且峰值不超过上限 4", async () => {
    const tradeNos = Array.from({ length: 12 }, (_, index) => `c${index + 1}`);
    currentGate = gate();

    await ingestAlipayBillFlows({ records: tradeNos.map(flow) }, ACCOUNT);

    expect(peakArrived).toBeGreaterThan(1);
    expect(peakArrived).toBe(EXPECTED_CONCURRENCY);
    expect(peakInFlight).toBeLessThanOrEqual(EXPECTED_CONCURRENCY);
    expect(createdOrder.slice(0, EXPECTED_CONCURRENCY)).toEqual(tradeNos.slice(0, EXPECTED_CONCURRENCY));
    expect(createCalls.size).toBe(tradeNos.length);
  });

  it("某条流水抛错时抛出的仍是第一个错误，且失败后没有再领取新记录", async () => {
    const tradeNos = Array.from({ length: 12 }, (_, index) => `f${index + 1}`);
    currentGate = gate();
    // 第二批领取到的记录（下标 4 → f5）租约认领失败：此时工作池里 4 条在飞，失败必须收敛。
    failClaimFor = "f5";
    const rejections: string[] = [];
    const onRejection = (reason: unknown) => { rejections.push(String(reason)); };
    process.on("unhandledRejection", onRejection);

    try {
      await expect(ingestAlipayBillFlows({ records: tradeNos.map(flow) }, ACCOUNT)).rejects.toThrow("SENTINEL_FAILURE");
      // 失败前必须有并发（否则"停止领取"无从谈起），失败后必须还有 4 条没被领取。
      expect(peakInFlight).toBeGreaterThan(1);
      // 闸门放行时工作池里 4 条在飞（f1..f4），每条协程在发现失败前最多再领取 1 条
      // （f5..f8，其中 f5 就是失败的那条）。因此确定性地只领取了 8 条：
      // 失败一旦记入，剩下的 f9..f12 一条都没有开始——这正是"停止领取新记录"。
      expect(createdOrder).toEqual(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"]);
      expect(tradeNos.slice(8).filter(tradeNo => createCalls.has(tradeNo))).toEqual([]);
      // 被处理的记录集合就是被领取的集合，失败后没有任何额外推进。
      expect(receipts.map(item => item.providerTradeNo)).toEqual(createdOrder);
      // 抛出的就是第一个错误，且没有悬空的 rejection。
      await tick();
      expect(rejections).toEqual([]);
      expect(events.some(event => event.aggregateId === "receipt-5")).toBe(false);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("去重路径仍然走到：P2002 复用已存在回执并标记 duplicate", async () => {
    const tradeNos = ["d1", "d2", "d3"];
    const records = tradeNos.map(flow);
    await ingestAlipayBillFlows({ records }, ACCOUNT);
    const rowsAfterFirstBatch = receipts.length;

    const second = await ingestAlipayBillFlows({ records }, ACCOUNT);

    expect(second.map(item => item.providerTradeNo)).toEqual(tradeNos);
    expect(second.every(item => item.duplicate)).toBe(true);
    expect(second.every(item => item.status === "MATCHED")).toBe(true);
    // 去重路径确实复用了既有回执：没有新建行，也没有因为重复而抛错。
    expect(receipts).toHaveLength(rowsAfterFirstBatch);
    for (const fingerprint of tradeNos.map(receiptKey)) {
      expect(receipts.filter(item => item.fingerprint === fingerprint)).toHaveLength(1);
    }
    expect(createCalls.get("d1")).toBe(2);
    expect(createCalls.get("d4")).toBeUndefined();
  });

  it("同一批里的重复流水也只产生一行回执，且不会让整批失败", async () => {
    const outcomes = await ingestAlipayBillFlows({ records: [flow("dup"), flow("dup")] }, ACCOUNT);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.map(item => item.duplicate)).toEqual([false, true]);
    expect(receipts.filter(item => item.fingerprint === receiptKey("dup"))).toHaveLength(1);
  });
});
