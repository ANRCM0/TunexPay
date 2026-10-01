import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), find: vi.fn(), latest: vi.fn(), raw: vi.fn(), update: vi.fn(),
  updateMany: vi.fn(), event: vi.fn(), delivery: vi.fn(),
}));
vi.mock("../services/channel-instance-service.js", () => ({ adapterForPayment: async () => ({ query: mocks.query }), assertChannelVerified: vi.fn() }));
vi.mock("../services/outbox-service.js", () => ({ createPaymentSucceededDelivery: mocks.delivery }));
vi.mock("../services/payment-exception-service.js", () => ({ openLateDuplicateException: vi.fn() }));
vi.mock("../lib/payment-wake.js", () => ({ publishPaymentChange: vi.fn() }));
vi.mock("../db.js", () => {
  const tx = {
    $queryRaw: mocks.raw,
    payment: { findFirst: mocks.find, findUnique: mocks.find, findUniqueOrThrow: mocks.latest, update: mocks.update, updateMany: mocks.updateMany },
    order: {
      findUniqueOrThrow: vi.fn(async () => ({ id: "o1", status: "PENDING", amount: 200, application: {} })),
      update: vi.fn(async ({ data }) => ({ id: "o1", amount: 200, ...data })),
    },
    paymentEvent: { create: mocks.event },
  };
  return { db: { ...tx, $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } };
});
import { queryPayment } from "../services/payment-service.js";

const payment = { id: "p1", paymentNo: "pay_1", orderId: "o1", channel: "ALIPAY", amount: 200, status: "PROCESSING", nextQueryAt: null, queryAttempts: 0 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.find.mockResolvedValue({ ...payment });
  mocks.latest.mockResolvedValue({ ...payment });
  mocks.update.mockImplementation(async ({ data }) => ({ ...payment, ...data }));
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("successful query amount contract", () => {
  it.each([undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid channel amount %s before touching success state", async amount => {
    mocks.query.mockResolvedValue({ status: "SUCCESS", amount, raw: {} });
    await expect(queryPayment(null, "pay_1")).rejects.toMatchObject({ code: "PAYMENT_QUERY_AMOUNT_INVALID" });
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.delivery).not.toHaveBeenCalled();
  });

  it("rejects a channel amount different from the local amount", async () => {
    mocks.query.mockResolvedValue({ status: "SUCCESS", amount: 199, raw: {}, channelTradeNo: "t1" });
    await expect(queryPayment(null, "pay_1")).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH", details: { expected: 200, actual: 199 } });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
    expect(mocks.delivery).not.toHaveBeenCalled();
  });

  it("commits matching channel amount through the unified success transaction", async () => {
    mocks.query.mockResolvedValue({ status: "SUCCESS", amount: 200, raw: {}, channelTradeNo: "t1" });
    expect((await queryPayment(null, "pay_1")).status).toBe("SUCCESS");
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", receivedAmount: 200 }) }));
    expect(mocks.delivery).toHaveBeenCalledTimes(1);
    expect(mocks.event).toHaveBeenCalledTimes(2);
  });

  it("does not reschedule a concurrent success after an unchanged query", async () => {
    mocks.query.mockResolvedValue({ status: "PROCESSING", raw: {} });
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.latest.mockResolvedValue({ ...payment, status: "SUCCESS" });
    expect((await queryPayment(null, "pay_1")).status).toBe("SUCCESS");
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: "p1", status: "PROCESSING", nextQueryAt: null, queryAttempts: 0 }, data: { nextQueryAt: expect.any(Date) } });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
