import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  channelFindUnique: vi.fn(),
  channelFindMany: vi.fn(),
  channelDelete: vi.fn(),
  channelUpdate: vi.fn(),
  applicationCount: vi.fn(),
  paymentCount: vi.fn(),
  refundCount: vi.fn(),
  receiptCount: vi.fn(),
  stateCount: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../db.js", () => ({
  db: {
    channelInstance: {
      findUnique: mocks.channelFindUnique,
      findMany: mocks.channelFindMany,
      delete: mocks.channelDelete,
      update: mocks.channelUpdate,
    },
    application: { count: mocks.applicationCount },
    payment: { count: mocks.paymentCount },
    refund: { count: mocks.refundCount },
    receipt: { count: mocks.receiptCount },
    billCollectorState: { count: mocks.stateCount },
    $transaction: mocks.transaction,
  },
}));

import { channelIdSchema, deleteChannel } from "../services/channel-instance-service.js";

const row = {
  id: "alipay-shop1", plugin: "ALIPAY", name: "Shop 1", enabled: true, revision: 3,
  payloadEncrypted: "v1.x.y.z", checkStatus: "API_VERIFIED", checkMessage: null, checkedAt: null,
  checkRevision: 3, checkLease: null, checkLockedUntil: null, testPaymentNo: null, testRevision: null,
  archivedAt: null, createdAt: new Date(), updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.channelFindUnique.mockResolvedValue({ ...row });
  mocks.applicationCount.mockResolvedValue(0);
  mocks.paymentCount.mockResolvedValue(0);
  mocks.refundCount.mockResolvedValue(0);
  mocks.receiptCount.mockResolvedValue(0);
  mocks.stateCount.mockResolvedValue(0);
  mocks.channelDelete.mockResolvedValue(row);
  mocks.channelUpdate.mockResolvedValue(row);
});

describe("channel id rules", () => {
  it("accepts operator-chosen ids and rejects unusable ones", () => {
    expect(channelIdSchema.parse("alipay-shop1")).toBe("alipay-shop1");
    expect(channelIdSchema.parse("  shop-2  ")).toBe("shop-2");
    expect(() => channelIdSchema.parse("Shop_1")).toThrow();
    expect(() => channelIdSchema.parse("-shop")).toThrow();
    expect(() => channelIdSchema.parse("ab")).toThrow();
  });
});

describe("deleteChannel", () => {
  it("hard deletes a channel that never carried any money", async () => {
    const result = await deleteChannel("alipay-shop1");
    expect(result).toMatchObject({ archived: false, retained: { payments: 0, refunds: 0 } });
    expect(mocks.channelDelete).toHaveBeenCalledWith({ where: { id: "alipay-shop1" } });
    expect(mocks.channelUpdate).not.toHaveBeenCalled();
  });

  it("archives instead of deleting once payments exist, keeping the credentials for later queries", async () => {
    mocks.paymentCount.mockResolvedValue(4);
    mocks.refundCount.mockResolvedValue(1);
    const result = await deleteChannel("alipay-shop1");
    expect(result).toMatchObject({ archived: true, retained: { payments: 4, refunds: 1 } });
    // 归档只打标记与停用，绝不删行：payloadEncrypted 是历史支付单查单/退款的唯一凭据。
    expect(mocks.channelDelete).not.toHaveBeenCalled();
    expect(mocks.channelUpdate).toHaveBeenCalledWith({ where: { id: "alipay-shop1" }, data: { archivedAt: expect.any(Date), enabled: false } });
  });

  it("archives when only receipt clues or collector progress exist", async () => {
    mocks.receiptCount.mockResolvedValue(2);
    expect((await deleteChannel("alipay-shop1")).archived).toBe(true);
    vi.clearAllMocks();
    mocks.channelFindUnique.mockResolvedValue({ ...row });
    mocks.applicationCount.mockResolvedValue(0);
    mocks.paymentCount.mockResolvedValue(0);
    mocks.refundCount.mockResolvedValue(0);
    mocks.receiptCount.mockResolvedValue(0);
    mocks.stateCount.mockResolvedValue(1);
    mocks.channelUpdate.mockResolvedValue(row);
    expect((await deleteChannel("alipay-shop1")).archived).toBe(true);
  });

  it("refuses to delete a channel that an application still uses", async () => {
    mocks.applicationCount.mockResolvedValue(2);
    await expect(deleteChannel("alipay-shop1")).rejects.toMatchObject({ code: "CHANNEL_IN_USE" });
    // 拒绝时必须什么都没改：既没删行也没归档。
    expect(mocks.channelDelete).not.toHaveBeenCalled();
    expect(mocks.channelUpdate).not.toHaveBeenCalled();
  });

  it("is idempotent for an already archived channel", async () => {
    mocks.channelFindUnique.mockResolvedValue({ ...row, archivedAt: new Date() });
    const result = await deleteChannel("alipay-shop1");
    expect(result.archived).toBe(true);
    expect(mocks.channelDelete).not.toHaveBeenCalled();
    expect(mocks.channelUpdate).not.toHaveBeenCalled();
  });

  it("reports a missing channel instead of silently succeeding", async () => {
    mocks.channelFindUnique.mockResolvedValue(null);
    await expect(deleteChannel("missing")).rejects.toMatchObject({ code: "CHANNEL_NOT_FOUND" });
  });
});
