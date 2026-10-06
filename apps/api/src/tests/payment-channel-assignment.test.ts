import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
  channelFindUniqueOrThrow: vi.fn(),
  orderFindFirst: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentCount: vi.fn(),
  paymentCreate: vi.fn(),
  paymentUpdate: vi.fn(),
  orderUpdate: vi.fn(),
  eventCreate: vi.fn(),
  orderFindUniqueOrThrow: vi.fn(),
}));

vi.mock("../db.js", () => {
  const tx = {
    $queryRaw: mocks.raw,
    channelInstance: { findUniqueOrThrow: mocks.channelFindUniqueOrThrow, findUnique: mocks.channelFindUniqueOrThrow },
    order: { findFirst: mocks.orderFindFirst, findUniqueOrThrow: mocks.orderFindUniqueOrThrow, update: mocks.orderUpdate },
    payment: { findUnique: mocks.paymentFindUnique, findUniqueOrThrow: mocks.paymentFindUnique, count: mocks.paymentCount, create: mocks.paymentCreate, update: mocks.paymentUpdate },
    paymentEvent: { create: mocks.eventCreate },
  };
  return { db: { ...tx, $transaction: async (fn: (tx: unknown) => unknown) => fn(tx), order: tx.order } };
});
vi.mock("../services/channel-instance-service.js", () => ({
  adapterForPayment: vi.fn(),
  assertChannelVerified: vi.fn(),
  ensureLegacyChannels: vi.fn(),
}));
vi.mock("../services/bill-settings-service.js", () => ({ billRuntimeConfig: vi.fn() }));
vi.mock("../services/receipt-reservation-service.js", () => ({ prepareReceiptPayment: vi.fn(async (_tx: unknown, payment: unknown) => payment) }));
vi.mock("../services/outbox-service.js", () => ({ createPaymentSucceededDelivery: vi.fn() }));
vi.mock("../services/payment-exception-service.js", () => ({ openLateDuplicateException: vi.fn() }));
vi.mock("../lib/payment-wake.js", () => ({ publishPaymentChange: vi.fn() }));

import { createPayment } from "../services/payment-service.js";

const baseApp = {
  id: "app_1", appId: "app_abc", name: "App", status: "ACTIVE", apiKeyHash: "", webhookUrl: null,
  webhookSecretEncrypted: "", epayPid: "1000000001", epayKeyEncrypted: "",
  defaultChannel: "ALIPAY", defaultChannelId: null, archivedAt: null, pausedAt: null,
  createdAt: new Date(), updatedAt: new Date(),
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.channelFindUniqueOrThrow.mockResolvedValue({ id: "alipay-shop1", plugin: "ALIPAY", enabled: true, archivedAt: null, revision: 1 });
  mocks.orderFindFirst.mockResolvedValue({ id: "ord_1", orderNo: "ord_1", amount: 1999, status: "CREATED", expiresAt: null });
});

describe("createPayment channel assignment", () => {
  it("refuses to create a payment when the application has no channel assigned", async () => {
    // 不存在隐式默认通道：猜一个通道等于让钱进错账号。
    await expect(createPayment(baseApp, "ord_1", { method: "alipay" })).rejects.toMatchObject({ code: "CHANNEL_NOT_ASSIGNED" });
    // 必须在打开事务之前就拒绝，不能先写库再报错。
    expect(mocks.raw).not.toHaveBeenCalled();
  });

  it("rejects an explicit channel that differs from the assigned one", async () => {
    const app = { ...(baseApp as object), defaultChannelId: "alipay-shop1" } as never;
    await expect(createPayment(app, "ord_1", { channel: "MOCK", method: "alipay" })).rejects.toMatchObject({ code: "CHANNEL_NOT_ASSIGNED" });
  });

  it("rejects a channel that was archived, pointing the operator at reassignment", async () => {
    mocks.channelFindUniqueOrThrow.mockResolvedValue({ id: "alipay-shop1", plugin: "ALIPAY", enabled: true, archivedAt: new Date(), revision: 1 });
    const app = { ...(baseApp as object), defaultChannelId: "alipay-shop1" } as never;
    await expect(createPayment(app, "ord_1", { method: "alipay" })).rejects.toMatchObject({ code: "CHANNEL_ARCHIVED" });
  });
});
