import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn(), order: vi.fn(), payment: vi.fn() }));
vi.mock("../db.js", () => ({ db: { application: { findUnique: mocks.find } } }));
vi.mock("../services/order-service.js", () => ({ createOrder: mocks.order }));
vi.mock("../services/payment-service.js", () => ({ createPayment: mocks.payment }));
import { epayRoutes } from "../routes/epay.js";
import { epaySign, seal } from "../lib/crypto.js";
const key = "local-test-epay-secret";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.mockResolvedValue({ order: { orderNo: "ord-1" } });
  mocks.payment.mockResolvedValue({ paymentNo: "pay-1", cashierUrl: "http://localhost/cashier/pay-1", clientPayload: null });
});
describe("ePay routing group compatibility", () => {
  it.each(["grp-1", null])("preserves group or direct routing for application group %s", async routingGroupId => {
    const application = { id: "app-1", status: "ACTIVE", archivedAt: null, routingGroupId, defaultChannel: "MOCK", epayKeyEncrypted: seal(key) };
    mocks.find.mockResolvedValue(application);
    const params: Record<string, string> = { pid: "123", out_trade_no: "external-one", money: "1.00", name: "测试订单", sign_type: "MD5" };
    params.sign = epaySign(params, key);
    const response = await epayRoutes.request(`/mapi.php?${new URLSearchParams(params)}`);
    expect(response.status).toBe(200);
    expect((await response.json() as { code: number }).code).toBe(1);
    const input = mocks.payment.mock.calls[0]?.[2];
    expect(input).toEqual(routingGroupId ? { method: "alipay" } : { method: "alipay", channel: "MOCK" });
    expect(mocks.payment.mock.calls[0]?.[3]).toBe("epay-payment:external-one");
  });
});
