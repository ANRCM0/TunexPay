import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisSet: vi.fn(), redisDel: vi.fn(), redisQuit: vi.fn(),
  queueAdd: vi.fn(), queueClose: vi.fn(), workerClose: vi.fn(),
  dbDisconnect: vi.fn(),
  recoverExpired: vi.fn(), listDue: vi.fn(), deliver: vi.fn(),
  paymentRecoveries: vi.fn(), refundRecoveries: vi.fn(), expirations: vi.fn(), receiptFlows: vi.fn(),
  collectors: vi.fn(), ownerNotifications: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: class { add = mocks.queueAdd; close = mocks.queueClose; },
  Worker: class { on = vi.fn(); close = mocks.workerClose; },
}));
vi.mock("ioredis", () => ({
  Redis: class { set = mocks.redisSet; del = mocks.redisDel; quit = mocks.redisQuit; },
}));
vi.mock("../db.js", () => ({ db: { $disconnect: mocks.dbDisconnect } }));
vi.mock("../config.js", () => ({ config: () => ({ REDIS_URL: "redis://test", NODE_ENV: "test" }) }));
vi.mock("../lib/logger.js", () => ({ log: vi.fn() }));
vi.mock("../lib/system-status.js", () => ({ WORKER_HEARTBEAT_KEY: "tuoxin:worker:heartbeat" }));
vi.mock("../services/webhook-worker-service.js", () => ({
  deliverWebhook: mocks.deliver, listDueDeliveryIds: mocks.listDue, recoverExpiredDeliveries: mocks.recoverExpired,
}));
vi.mock("../services/recovery-service.js", () => ({
  runDuePaymentRecoveries: mocks.paymentRecoveries, runDueRefundRecoveries: mocks.refundRecoveries,
}));
vi.mock("../services/expiration-service.js", () => ({ runDueOrderExpirations: mocks.expirations }));
vi.mock("../services/receipt-flow-service.js", () => ({ recoverStaleAlipayBillFlows: mocks.receiptFlows }));
vi.mock("../services/alipay-bill-collector-service.js", () => ({ runAllBillCollectors: mocks.collectors }));
vi.mock("../services/owner-notification-service.js", () => ({ runOwnerNotifications: mocks.ownerNotifications }));

const TICK = 3_000;

/** 全部扫描都「没活干」。 */
function idleAll() {
  mocks.recoverExpired.mockResolvedValue(0);
  mocks.listDue.mockResolvedValue([]);
  mocks.paymentRecoveries.mockResolvedValue({ claimed: 0 });
  mocks.refundRecoveries.mockResolvedValue({ claimed: 0 });
  mocks.expirations.mockResolvedValue({ claimed: 0 });
  mocks.receiptFlows.mockResolvedValue({ found: 0 });
  mocks.collectors.mockResolvedValue(undefined);
  mocks.ownerNotifications.mockResolvedValue(undefined);
  mocks.redisSet.mockResolvedValue("OK");
  mocks.queueAdd.mockResolvedValue(undefined);
}

/** 载入 worker 模块并让首个 tick 的微任务落地。 */
async function boot(): Promise<void> {
  vi.resetModules();
  await import("../worker.js");
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

describe("worker polling behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    idleAll();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs webhook discovery and the bill collector on every tick", async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(TICK * 11);

    expect(mocks.listDue.mock.calls.length).toBe(12);
    expect(mocks.collectors.mock.calls.length).toBe(12);
  });

  it("backs the recovery scans off while the worker is idle", async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(TICK * 11);

    // 12 跳里重活只跑 7 次：第 1、2、3 跳每跳，之后按 2 跳、3 跳逐步放宽
    expect(mocks.paymentRecoveries.mock.calls.length).toBe(7);
    expect(mocks.paymentRecoveries.mock.calls.length).toBeLessThan(mocks.listDue.mock.calls.length);
  });

  it("returns to scanning every tick once a scan claims work again", async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(TICK * 11);
    expect(mocks.paymentRecoveries.mock.calls.length).toBe(7);

    // 退避已经到 stride 3，所以要再等最多两跳才会轮到这个扫描
    mocks.paymentRecoveries.mockResolvedValue({ claimed: 1 });
    await vi.advanceTimersByTimeAsync(TICK * 3);
    const afterClaim = mocks.paymentRecoveries.mock.calls.length;
    expect(afterClaim).toBeGreaterThan(7);

    // 领到任务后 idleTicks 归零、stride 回到 1，接下来每一跳都扫
    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(mocks.paymentRecoveries.mock.calls.length - afterClaim).toBe(3);
  });

  it("keeps discovering webhooks while a recovery scan is still in flight", async () => {
    // 恢复扫描卡住不返回：关键通知的发现路径不能被它拖住
    mocks.paymentRecoveries.mockReturnValue(new Promise(() => undefined));
    await boot();
    await vi.advanceTimersByTimeAsync(TICK * 4);

    expect(mocks.listDue.mock.calls.length).toBe(5);
  });

  it("stops refreshing the heartbeat when the fast path fails", async () => {
    await boot();
    expect(mocks.redisSet).toHaveBeenCalledTimes(1);

    // 数据库挂了：快速通道抛错，心跳不再刷新，管理台会据此显示 STALE
    mocks.listDue.mockRejectedValue(new Error("ECONNREFUSED"));
    await vi.advanceTimersByTimeAsync(TICK * 4);

    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
  });

  it("refreshes the heartbeat again once the fast path recovers", async () => {
    mocks.listDue.mockRejectedValue(new Error("ECONNREFUSED"));
    await boot();
    expect(mocks.redisSet).not.toHaveBeenCalled();

    mocks.listDue.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(mocks.redisSet.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
