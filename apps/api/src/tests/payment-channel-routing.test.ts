import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn(), latest: vi.fn(), update: vi.fn(), raw: vi.fn(), adapter: vi.fn(), query: vi.fn(), refundQuery: vi.fn(), webhook: vi.fn() }));
vi.mock("../services/channel-instance-service.js", () => ({ adapterForPayment: mocks.adapter, ensureLegacyChannels: vi.fn(), assertChannelVerified: vi.fn() }));
vi.mock("../db.js", () => {
  const tx = { payment: { findFirst: mocks.find, findUnique: mocks.find, findUniqueOrThrow: mocks.latest, update: mocks.update }, refund: { findFirst: mocks.find }, $queryRaw: mocks.raw };
  return { db: { ...tx, $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } };
});
import { handleAlipayWebhook, queryPayment } from "../services/payment-service.js";
import { queryRefund } from "../services/refund-service.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter.mockResolvedValue({ query: mocks.query, queryRefund: mocks.refundQuery, handleWebhook: mocks.webhook });
});
describe("historical channel routing", () => {
  it("does not overwrite a success callback with an older query observation", async () => {
    const payment = { id: "p", paymentNo: "pay-old", channel: "ALIPAY", channelId: "account-a", status: "UNKNOWN", queryAttempts: 1, nextQueryAt: new Date() };
    mocks.find.mockResolvedValue(payment);
    mocks.query.mockImplementation(async () => {
      mocks.latest.mockResolvedValue({ ...payment, status: "SUCCESS" });
      return { status: "PROCESSING", raw: {} };
    });
    expect((await queryPayment(null, payment.paymentNo)).status).toBe("SUCCESS");
    expect(mocks.adapter).toHaveBeenCalledWith(expect.objectContaining({ channelId: "account-a" }));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.raw).toHaveBeenCalled();
  });
  it("queries a refund through its original payment channel", async () => {
    const payment = { paymentNo: "pay-old", channel: "ALIPAY", channelId: "account-a", channelTradeNo: "trade-a" };
    mocks.find.mockResolvedValue({ refundNo: "refund-old", payment, status: "PROCESSING", nextQueryAt: new Date() });
    mocks.refundQuery.mockResolvedValue({ status: "PROCESSING", raw: {} });
    await queryRefund(null, "refund-old");
    expect(mocks.adapter).toHaveBeenCalledWith(payment);
    expect(mocks.refundQuery).toHaveBeenCalledWith({ paymentNo: "pay-old", refundNo: "refund-old", channelTradeNo: "trade-a" });
  });
  it("selects callback verification credentials using the bound payment", async () => {
    const payment = { paymentNo: "pay-b", channel: "ALIPAY", channelId: "account-b" };
    mocks.find.mockResolvedValue(payment);
    mocks.webhook.mockRejectedValue(new Error("signature rejected"));
    await expect(handleAlipayWebhook({ out_trade_no: "pay-b", app_id: "wrong-app" })).rejects.toThrow("signature rejected");
    expect(mocks.adapter).toHaveBeenCalledWith(payment);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
