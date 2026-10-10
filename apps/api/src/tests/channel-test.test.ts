import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findPayment: vi.fn(),
  upsertApp: vi.fn(),
  loadChannel: vi.fn(),
  createOrder: vi.fn(),
  createPayment: vi.fn(),
  closePayment: vi.fn(),
}));

vi.mock("../db.js", () => ({
  db: {
    channelInstance: { updateMany: mocks.updateMany },
    payment: { findUnique: mocks.findPayment },
    application: { upsert: mocks.upsertApp },
  },
}));
vi.mock("../services/channel-instance-service.js", () => ({ loadChannel: mocks.loadChannel }));
vi.mock("../services/order-service.js", () => ({ createOrder: mocks.createOrder }));
vi.mock("../services/payment-service.js", () => ({ createPayment: mocks.createPayment, closePayment: mocks.closePayment }));

import { createChannelTest } from "../services/channel-test-service.js";

const channel = { id: "chn_1", plugin: "ALIPAY_BILL", name: "账单收款", testPaymentNo: "pay_old", testRevision: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.loadChannel.mockResolvedValue(channel);
  mocks.upsertApp.mockResolvedValue({ id: "app_1" });
  mocks.createOrder.mockResolvedValue({ order: { orderNo: "ord_1" } });
  mocks.createPayment.mockResolvedValue({ paymentNo: "pay_new", cashierUrl: "http://localhost:3000/cashier/pay_new", status: "PROCESSING" });
  mocks.closePayment.mockResolvedValue({});
});

describe("createChannelTest", () => {
  it("creates the diagnostic order with the requested amount", async () => {
    mocks.findPayment.mockResolvedValue(null);
    const result = await createChannelTest("chn_1", 3, 199);
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: 199 }), undefined);
    expect(result.paymentNo).toBe("pay_new");
  });

  it("reuses the open test payment only when amount and validity still match", async () => {
    mocks.findPayment.mockResolvedValue({ paymentNo: "pay_old", status: "PROCESSING", amount: 199, clientPayload: { type: "qr_code" }, order: { expiresAt: new Date(Date.now() + 60_000) } });
    const result = await createChannelTest("chn_1", 3, 199);
    expect(result.paymentNo).toBe("pay_old");
    expect(mocks.createOrder).not.toHaveBeenCalled();

    const other = await createChannelTest("chn_1", 3, 299);
    expect(other.paymentNo).toBe("pay_new");
    expect(mocks.closePayment).toHaveBeenCalledWith(null, "pay_old", "CHANNEL_TEST");
  });

  it("closes a stale attempt and starts fresh instead of blocking on it", async () => {
    mocks.findPayment.mockResolvedValue({ paymentNo: "pay_old", status: "PROCESSING", amount: 199, clientPayload: { type: "qr_code" }, order: { expiresAt: new Date(Date.now() - 60_000) } });
    const result = await createChannelTest("chn_1", 3, 199);
    expect(mocks.closePayment).toHaveBeenCalledWith(null, "pay_old", "CHANNEL_TEST");
    expect(result.paymentNo).toBe("pay_new");
  });

  it("starts a new test immediately after the previous one succeeded", async () => {
    mocks.findPayment.mockResolvedValue({ paymentNo: "pay_old", status: "SUCCESS", amount: 199, clientPayload: null, order: { expiresAt: new Date(Date.now() + 60_000) } });
    const result = await createChannelTest("chn_1", 3, 199);
    expect(mocks.createOrder).toHaveBeenCalled();
    expect(mocks.closePayment).not.toHaveBeenCalled();
    expect(result.paymentNo).toBe("pay_new");
  });
});
