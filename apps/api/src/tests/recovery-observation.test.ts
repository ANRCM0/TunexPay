import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  raw: vi.fn(), current: vi.fn(), update: vi.fn(), event: vi.fn(), claim: vi.fn(), query: vi.fn(), attempts: 0,
}));
vi.mock("../services/payment-service.js", () => ({ queryPayment: mocks.query }));
vi.mock("../services/refund-service.js", () => ({ queryRefund: mocks.query }));
vi.mock("../db.js", () => {
  const model = {
    findMany: vi.fn(async () => [{ id: "record_1", paymentNo: "pay_1", refundNo: "ref_1", paymentId: "p1", queryAttempts: mocks.attempts, payment: { orderId: "o1" } }]),
    findUnique: mocks.current, updateMany: mocks.claim, update: mocks.update,
  };
  const tx = { payment: model, refund: model, $queryRaw: mocks.raw, paymentEvent: { create: mocks.event } };
  return { db: { ...tx, $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } };
});
import { RECOVERY_MAX_ATTEMPTS } from "../lib/recovery-policy.js";
import { runDuePaymentRecoveries } from "../services/recovery-service.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attempts = 0;
  mocks.claim.mockResolvedValue({ count: 1 });
  mocks.current.mockResolvedValue({ orderId: "o1", status: "SUCCESS", nextQueryAt: null });
});

// 只有支付单参与自动查单。退款侧不再有恢复扫描（refund-service.queryRefund 只由人工触发），
// 所以这里没有 refund 的对照分支。
describe("payment recovery current-state ownership", () => {
  it("locks before checking state and does not attach stale errors to a concurrent success", async () => {
    mocks.query.mockRejectedValue(new Error("old network failure"));
    expect(await runDuePaymentRecoveries()).toMatchObject({ claimed: 1, failed: 1, exhausted: 0 });
    expect(mocks.raw).toHaveBeenCalledTimes(1);
    expect(String(mocks.raw.mock.calls[0]![0])).toContain("FOR UPDATE");
    expect(mocks.raw.mock.invocationCallOrder[0]).toBeLessThan(mocks.current.mock.invocationCallOrder[0]!);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it("does not emit exhaustion or reschedule a success after an old processing result", async () => {
    mocks.attempts = RECOVERY_MAX_ATTEMPTS - 1;
    mocks.query.mockResolvedValue({ status: "PROCESSING" });
    expect(await runDuePaymentRecoveries()).toMatchObject({ claimed: 1, exhausted: 0 });
    expect(mocks.raw).toHaveBeenCalledTimes(1);
    expect(mocks.raw.mock.invocationCallOrder[0]).toBeLessThan(mocks.current.mock.invocationCallOrder[0]!);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it("still records a failure and schedules a currently recoverable record", async () => {
    mocks.current.mockResolvedValue({ orderId: "o1", status: "PROCESSING", nextQueryAt: new Date() });
    mocks.query.mockRejectedValue(new Error("network failure"));
    await runDuePaymentRecoveries();
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: { errorCode: "RECOVERY_QUERY_ERROR", errorMessage: "network failure", nextQueryAt: expect.any(Date) } }));
    expect(mocks.event).toHaveBeenCalledTimes(1);
  });
});
