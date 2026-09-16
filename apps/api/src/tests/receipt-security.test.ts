import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), findUnique: vi.fn(), succeed: vi.fn(), update: vi.fn() }));
vi.mock("../services/payment-service.js", () => ({ markPaymentSucceeded: mocks.succeed }));
vi.mock("../db.js", () => {
  const db = {
    payment: { findMany: mocks.findMany, findUnique: mocks.findUnique },
    receipt: {
      create: async () => ({ id: "receipt", matchStatus: "UNMATCHED" }),
      updateMany: async () => ({ count: 1 }), update: mocks.update,
    }, paymentEvent: { create: async () => ({}) },
  };
  return { db: { ...db, $transaction: async (callback: (tx: typeof db) => Promise<unknown>) => callback(db) } };
});
import { ingestAlipayBillFlows } from "../services/receipt-flow-service.js";
const payment = { id: "payment", paymentNo: "pay_test", orderId: "order", receiptMatchMode: "REMARK", receiptMatchReference: "TXA1B2C3D4E5", channel: "ALIPAY_BILL", channelAmount: 1000, amount: 1000 };
beforeEach(() => {
  vi.clearAllMocks(); mocks.findMany.mockResolvedValue([]); mocks.findUnique.mockResolvedValue(null);
  mocks.update.mockImplementation(async ({ data }) => ({ id: "receipt", ...data }));
});
function ingest(remark: string | null, merchantOrderNo?: string) {
  return ingestAlipayBillFlows({ record: { providerTradeNo: "trade", amount: 1000, paidAt: "2026-09-16 12:00:00", remark, merchantOrderNo } });
}
describe("strict receipt matching", () => {
  it("restricts amount fallback to payments explicitly created in AMOUNT mode", async () => {
    expect((await ingest(null))[0]?.status).toBe("UNMATCHED");
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ receiptMatchMode: "AMOUNT" }) }));
    expect(mocks.succeed).not.toHaveBeenCalled();
  });
  it("does not bypass required remark even with a direct merchant order reference", async () => {
    mocks.findMany.mockResolvedValue([payment]);
    expect((await ingest(null, "pay_test"))[0]?.status).toBe("MISMATCH");
    expect(mocks.succeed).not.toHaveBeenCalled();
  });
  it("rejects multiple remark references without trying amount fallback", async () => {
    expect((await ingest("TXA1B2C3D4E5 TX1111111111"))[0]?.status).toBe("MISMATCH");
    expect(mocks.findMany).not.toHaveBeenCalled(); expect(mocks.succeed).not.toHaveBeenCalled();
  });
});
