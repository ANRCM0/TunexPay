import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), ingest: vi.fn(), upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn(), find: vi.fn(), cfg: {
  ALIPAY_BILL_COLLECTOR_ENABLED: true, ALIPAY_APP_ID: "app", ALIPAY_BILL_USER_ID: "2088000000000000", ALIPAY_GATEWAY: "https://openapi.alipay.com/gateway.do", ALIPAY_BILL_QR_CONTENT: "qr", ALIPAY_BILL_LOOKBACK_SECONDS: 3600, ALIPAY_BILL_OVERLAP_SECONDS: 300, ALIPAY_BILL_LAG_SECONDS: 15, ALIPAY_BILL_POLL_SECONDS: 10,
} }));
vi.mock("../config.js", () => ({ config: () => mocks.cfg }));
vi.mock("../db.js", () => {
  const database = { billCollectorState: { upsert: mocks.upsert, update: mocks.update, updateMany: mocks.updateMany, findUniqueOrThrow: mocks.find, findUnique: mocks.find } };
  return { db: { ...database, $transaction: async (callback: (tx: typeof database) => Promise<unknown>) => callback(database) } };
});
vi.mock("../services/bill-settings-service.js", () => ({ billRuntimeConfig: async () => ({ ...mocks.cfg, billRevision: 1 }) }));
vi.mock("../channels/alipay.js", () => ({ AlipayChannel: class { queryAccountLogs = mocks.query; } }));
vi.mock("../services/receipt-flow-service.js", () => ({ ingestAlipayBillFlows: mocks.ingest }));
vi.mock("../services/receipt-reservation-service.js", () => ({ ALIPAY_BILL_ACCOUNT_ID: "alipay-bill-default" }));
vi.mock("../lib/logger.js", () => ({ log: vi.fn() }));

import { runAlipayBillCollector, alipayBillCollectorStatus } from "../services/alipay-bill-collector-service.js";

// In-memory database double exercises checkpoint ordering and lease predicates;
// actual MySQL concurrent transaction tests remain a deployment acceptance step.
let state: Record<string, any>;
function apply(data: Record<string, any>) {
  for (const [key, value] of Object.entries(data)) state[key] = value && typeof value === "object" && "increment" in value ? (state[key] || 0) + value.increment : value;
}
function matches(where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return value.some(matches);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("lte" in value) return state[key] !== null && state[key] <= value.lte;
      if ("gt" in value) return state[key] !== null && state[key] > value.gt;
    }
    return state[key] === value;
  });
}
const row = { income: "0.01", outcome: "0.00", alipay_order_no: "trade-1", trans_dt: "2026-09-16 11:20:00", trans_memo: "TXA1B2C3D4E5" };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-16T04:00:00Z")); vi.clearAllMocks();
  mocks.cfg.ALIPAY_BILL_COLLECTOR_ENABLED = true; mocks.cfg.ALIPAY_BILL_QR_CONTENT = "qr";
  state = {};
  mocks.upsert.mockImplementation(async ({ create }) => {
    if (!state.id) state = { ...create, nextRunAt: new Date(0), nextPage: 1, windowStart: null, windowEnd: null, leaseOwner: null, lockedUntil: null, consecutiveErrors: 0, processedRecords: 0, lastError: null, lastSuccessAt: null };
    return structuredClone(state);
  });
  mocks.find.mockImplementation(async () => structuredClone(state));
  mocks.update.mockImplementation(async ({ data }) => { apply(data); return structuredClone(state); });
  mocks.updateMany.mockImplementation(async ({ where, data }) => { if (!matches(where)) return { count: 0 }; apply(data); return { count: 1 }; });
  mocks.ingest.mockResolvedValue([{ status: "MATCHED" }]);
  mocks.query.mockResolvedValue({ total_size: 1, account_log_list: [row] });
});
afterEach(() => vi.useRealTimers());

describe("independent Alipay collector", () => {
  it("persists a receipt before advancing a completed window", async () => {
    mocks.ingest.mockImplementation(async () => { expect(state.cursorAt.toISOString()).toBe("2026-09-16T03:00:00.000Z"); });
    await runAlipayBillCollector();
    expect(mocks.query).toHaveBeenCalledWith({ bill_user_id: "2088000000000000", start_time: "2026-09-16 10:55:00", end_time: "2026-09-16 11:30:00", page_no: 1, page_size: 100 });
    expect(state.cursorAt.toISOString()).toBe("2026-09-16T03:30:00.000Z");
    expect(state.windowEnd).toBeNull(); expect(state.leaseOwner).toBeNull();
    expect((await alipayBillCollectorStatus()).status).toBe("RUNNING");
  });
  it("retains window and page after delivery failure and retries the same page", async () => {
    mocks.ingest.mockRejectedValueOnce(new Error("temporary database failure"));
    await runAlipayBillCollector();
    expect(state.cursorAt.toISOString()).toBe("2026-09-16T03:00:00.000Z");
    expect(state.nextPage).toBe(1); expect(state.consecutiveErrors).toBe(1);
    const window = state.windowEnd.toISOString();
    await runAlipayBillCollector(); expect(mocks.query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(21000); await runAlipayBillCollector();
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0]![0]).toEqual(mocks.query.mock.calls[1]![0]);
    expect(state.cursorAt.toISOString()).toBe(window);
  });
  it("keeps the cursor on provider/schema failures", async () => {
    mocks.query.mockResolvedValue({ total_size: 10 });
    await runAlipayBillCollector();
    expect(state.lastError).toBe("ALIPAY_BILL_INVALID_PAGE");
    expect(state.cursorAt.toISOString()).toBe("2026-09-16T03:00:00.000Z");
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect((await alipayBillCollectorStatus()).status).toBe("ERROR");
  });
  it("continues a fixed window at page six after the five-page budget", async () => {
    mocks.query.mockImplementation(async ({ page_no }) => ({ total_size: 501, account_log_list: page_no <= 5 ? Array(100).fill({ ...row, income: "0.00", outcome: "0.01" }) : [row] }));
    await runAlipayBillCollector();
    expect(state.nextPage).toBe(6); expect(state.windowEnd).not.toBeNull();
    vi.advanceTimersByTime(11000); await runAlipayBillCollector();
    expect(mocks.query.mock.calls[5]![0].page_no).toBe(6);
    expect(mocks.query.mock.calls[0]![0].end_time).toBe(mocks.query.mock.calls[5]![0].end_time);
    expect(state.windowEnd).toBeNull();
  });
  it("does not query while another owner holds a lease", async () => {
    await runAlipayBillCollector(); mocks.query.mockClear(); vi.advanceTimersByTime(11000);
    state.leaseOwner = "other"; state.lockedUntil = new Date(Date.now() + 60000);
    await runAlipayBillCollector(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("pauses on account changes and never silently resets historical state", async () => {
    await runAlipayBillCollector(); mocks.query.mockClear(); mocks.cfg.ALIPAY_BILL_QR_CONTENT = "another-account";
    await runAlipayBillCollector(); expect(mocks.query).not.toHaveBeenCalled();
    expect(state.lastError).toMatch(/^ACCOUNT_BINDING_CHANGED/);
  });
  it("does nothing when disabled and reports stale worker heartbeat", async () => {
    mocks.cfg.ALIPAY_BILL_COLLECTOR_ENABLED = false; await runAlipayBillCollector(); expect(mocks.upsert).not.toHaveBeenCalled();
    mocks.cfg.ALIPAY_BILL_COLLECTOR_ENABLED = true; await runAlipayBillCollector();
    vi.advanceTimersByTime(100000); expect((await alipayBillCollectorStatus()).status).toBe("OFFLINE");
  });
});
