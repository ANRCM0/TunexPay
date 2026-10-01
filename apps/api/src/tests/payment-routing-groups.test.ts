import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ raw: vi.fn(), order: vi.fn(), orderById: vi.fn(), orderUpdate: vi.fn(), find: vi.fn(), latest: vi.fn(),
  count: vi.fn(), create: vi.fn(), update: vi.fn(), event: vi.fn(), transaction: vi.fn(), select: vi.fn(), adapter: vi.fn(), upstream: vi.fn(), prepare: vi.fn(), bill: vi.fn(),
}));
vi.mock("../db.js", () => {
  const tx = { $queryRaw: mocks.raw, order: { findFirst: mocks.order, findUniqueOrThrow: mocks.orderById, update: mocks.orderUpdate },
    payment: { findUnique: mocks.find, findUniqueOrThrow: mocks.latest, count: mocks.count, create: mocks.create, update: mocks.update }, paymentEvent: { create: mocks.event } };
  return { db: { ...tx, $transaction: mocks.transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx)) } };
});
vi.mock("../services/routing-group-service.js", () => ({ selectRoutingChannel: mocks.select }));
vi.mock("../services/channel-instance-service.js", () => ({ adapterForPayment: mocks.adapter, assertChannelVerified: vi.fn() }));
vi.mock("../services/receipt-reservation-service.js", () => ({ prepareReceiptPayment: mocks.prepare }));
vi.mock("../services/bill-settings-service.js", () => ({ billRuntimeConfig: mocks.bill }));
vi.mock("../lib/payment-wake.js", () => ({ publishPaymentChange: vi.fn() }));
import { createPayment } from "../services/payment-service.js";
import { AppError, ChannelDefinitiveError, ChannelUncertainError } from "../lib/errors.js";

const application = { id: "app-1", appId: "app-group", defaultChannel: "MOCK", defaultChannelId: null, routingGroupId: "grp-1" } as never;
let stored: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  stored = {};
  mocks.order.mockResolvedValue({ id: "ord-1", orderNo: "order-one", status: "CREATED", amount: 1999, expiresAt: null });
  mocks.orderById.mockResolvedValue({ id: "ord-1", subject: "订单", amount: 1999 });
  mocks.find.mockResolvedValue(null); mocks.count.mockResolvedValue(0);
  mocks.select.mockResolvedValue({ channel: { id: "account-b", plugin: "ALIPAY", enabled: true }, strategy: "WEIGHTED_RANDOM" });
  mocks.create.mockImplementation(async ({ data }: { data: object }) => { stored = { id: "pay-row", status: "CREATED", queryAttempts: 0, ...data }; return { ...stored }; });
  mocks.update.mockImplementation(async ({ data }: { data: object }) => { stored = { ...stored, ...data }; return { ...stored }; });
  mocks.latest.mockImplementation(async () => ({ ...stored }));
  mocks.prepare.mockImplementation(async (_tx: unknown, payment: object) => payment);
  mocks.adapter.mockResolvedValue({ create: mocks.upstream });
  mocks.upstream.mockResolvedValue({ status: "PROCESSING", channelOrderNo: "provider-order", raw: {}, clientPayload: { type: "qr_code", value: "qr" } });
});

describe("payment routing group integration", () => {
  it("uses the selected group member instead of the old default plugin", async () => {
    const payment = await createPayment(application, "order-one", { method: "alipay" }, "request-one");
    expect(payment).toMatchObject({ channel: "ALIPAY", channelId: "account-b", routingGroupId: "grp-1" });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith(expect.anything(), "grp-1", undefined);
    expect(mocks.adapter).toHaveBeenCalledWith(expect.objectContaining({ channelId: "account-b" }));
    expect(mocks.upstream).toHaveBeenCalledWith(expect.objectContaining({ notifyUrl: expect.stringContaining("/alipay/webhook") }));
    expect(mocks.transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  });
  it("records selected channel, group and strategy in the creation event", async () => {
    await createPayment(application, "order-one", { method: "alipay" });
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "PAYMENT_CREATED", payload: expect.objectContaining({ channelId: "account-b", routingGroupId: "grp-1", routingStrategy: "WEIGHTED_RANDOM" }) }) }));
  });
  it("passes an explicit plugin only as a group candidate filter", async () => {
    await createPayment(application, "order-one", { channel: "ALIPAY", method: "alipay" });
    expect(mocks.select).toHaveBeenCalledWith(expect.anything(), "grp-1", "ALIPAY");
  });
  it("prepares bill reservations in the selected account scope", async () => {
    mocks.select.mockResolvedValue({ channel: { id: "bill-b", plugin: "ALIPAY_BILL" }, strategy: "RANDOM" });
    const payment = await createPayment(application, "order-one", { method: "alipay" });
    expect(payment.channelId).toBe("bill-b");
    expect(mocks.bill).toHaveBeenCalledWith(expect.anything(), true, "bill-b");
    expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ channelId: "bill-b" }), null);
    expect(mocks.upstream).toHaveBeenCalledWith(expect.objectContaining({ notifyUrl: expect.stringContaining("/alipay_bill/webhook") }));
  });
  it.each(["ROUTING_GROUP_DISABLED", "ROUTING_GROUP_NO_CHANNEL", "ROUTING_GROUP_NOT_FOUND"])("never creates or dispatches a payment when selection fails with %s", async code => {
    mocks.select.mockRejectedValue(new AppError(code, "轮询组不可用", 409));
    await expect(createPayment(application, "order-one", { method: "alipay" })).rejects.toMatchObject({ code });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it.each(["CREATED", "SUCCESS", "CLOSED"])("reuses the original idempotent payment even when order is %s", async status => {
    mocks.order.mockResolvedValue({ id: "ord-1", status, expiresAt: new Date(0) });
    mocks.find.mockResolvedValue({ id: "existing", paymentNo: "pay-original", channelId: "original-account", routingGroupId: "old-group", status: "PROCESSING" });
    mocks.select.mockRejectedValue(new Error("group removed"));
    const payment = await createPayment(application, "order-one", { method: "alipay" }, "same-key");
    expect(payment.channelId).toBe("original-account");
    expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("also preserves idempotent payments after the application is unbound", async () => {
    mocks.find.mockResolvedValue({ id: "existing", paymentNo: "pay-original", channelId: "original-account" });
    const unbound = { ...(application as object), routingGroupId: null, defaultChannelId: null } as never;
    expect((await createPayment(unbound, "order-one", { method: "alipay" }, "same-key")).channelId).toBe("original-account");
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("does not route closed or expired orders without a prior idempotent payment", async () => {
    mocks.order.mockResolvedValue({ id: "ord-1", status: "CREATED", expiresAt: new Date(0) });
    await expect(createPayment(application, "order-one", { method: "alipay" }, "new-key")).rejects.toMatchObject({ code: "ORDER_EXPIRED" });
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it.each([new ChannelUncertainError("timeout"), new ChannelDefinitiveError("DENIED", "denied")])("does not redraw or retry another account after an upstream error", async error => {
    mocks.upstream.mockRejectedValue(error);
    const result = await createPayment(application, "order-one", { method: "alipay" });
    expect(result.status).toBe(error instanceof ChannelUncertainError ? "UNKNOWN" : "FAILED");
    expect(result.channelId).toBe("account-b");
    expect(mocks.select).toHaveBeenCalledTimes(1); expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });
});
