import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ current: vi.fn(), raw: vi.fn(), update: vi.fn(), event: vi.fn(), query: vi.fn() }));
vi.mock("../services/payment-service.js", () => ({ queryPayment: mocks.query, closePayment: vi.fn() }));
vi.mock("../db.js", () => {
  const order = {
    findMany: vi.fn(async () => [{ id: "o1", orderNo: "ord_1", expirationAttempts: 0 }]),
    updateMany: vi.fn(async () => ({ count: 1 })),
    findUnique: vi.fn(async ({ where }) => where.orderNo
      ? { id: "o1", orderNo: "ord_1", status: "PENDING", payments: [{ paymentNo: "pay_1", channel: "ALIPAY", status: "PROCESSING" }] }
      : mocks.current()),
    update: mocks.update,
  };
  const tx = { order, $queryRaw: mocks.raw, paymentEvent: { create: mocks.event } };
  return { db: { ...tx, $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } };
});
import { runDueOrderExpirations } from "../services/expiration-service.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockRejectedValue(new Error("old query timeout"));
});
describe("expiration failure after a concurrent payment success", () => {
  it("locks before reading state and does not reattach expiration scheduling to a success", async () => {
    mocks.current.mockResolvedValue({ status: "SUCCESS" });
    expect(await runDueOrderExpirations()).toMatchObject({ claimed: 1, failed: 1 });
    expect(String(mocks.raw.mock.calls[0]![0])).toContain("FOR UPDATE");
    expect(mocks.raw.mock.invocationCallOrder[0]).toBeLessThan(mocks.current.mock.invocationCallOrder[0]!);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it("still schedules a retry when the current order is pending", async () => {
    mocks.current.mockResolvedValue({ status: "PENDING" });
    await runDueOrderExpirations();
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "o1" }, data: { expirationLockedUntil: null, expirationNextAttemptAt: expect.any(Date), expirationError: "old query timeout" } });
    expect(mocks.event).toHaveBeenCalledTimes(1);
  });
});
