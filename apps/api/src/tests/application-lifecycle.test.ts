import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  count: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../db.js", () => ({
  db: {
    application: { findUnique: mocks.findUnique, update: mocks.update, delete: mocks.remove },
    order: { findMany: mocks.findMany, updateMany: mocks.updateMany },
    payment: { findMany: mocks.findMany, count: mocks.count, deleteMany: mocks.deleteMany },
    refund: { findMany: mocks.findMany, count: mocks.count, deleteMany: mocks.deleteMany },
    receipt: { findMany: mocks.findMany, deleteMany: mocks.deleteMany },
    paymentEvent: { count: mocks.count, deleteMany: mocks.deleteMany },
    paymentException: { count: mocks.count, deleteMany: mocks.deleteMany },
    webhookDelivery: { count: mocks.count, deleteMany: mocks.deleteMany },
    $transaction: mocks.transaction,
  },
}));
// 应用生命周期只碰 application 表，通道校验在本用例里不需要真实实现。
vi.mock("../services/channel-instance-service.js", () => ({ loadChannel: vi.fn(), assertChannelVerified: vi.fn() }));

import { deleteApplication, INTERNAL_APPLICATION_ID, rotateApplicationCredentials, updateApplicationStatus } from "../services/application-service.js";
import { openSealed, sha256 } from "../lib/crypto.js";

const row = { id: "app_row_1", appId: "app_matrix", name: "TUOXIN Matrix", epayPid: "1234567890", status: "ACTIVE" as const, apiKeyHash: "hash", webhookSecretEncrypted: "sealed", epayKeyEncrypted: "sealed" };

// 归档路径在同一个事务里按依赖顺序清理，事务客户端就是 db 本身的最小子集。
const tx = {
  application: { findUniqueOrThrow: mocks.findUnique, update: mocks.update },
  order: { findMany: mocks.findMany, updateMany: mocks.updateMany },
  payment: { findMany: mocks.findMany, count: mocks.count, deleteMany: mocks.deleteMany },
  refund: { findMany: mocks.findMany, count: mocks.count, deleteMany: mocks.deleteMany },
  receipt: { findMany: mocks.findMany, deleteMany: mocks.deleteMany },
  paymentEvent: { count: mocks.count, deleteMany: mocks.deleteMany },
  paymentException: { count: mocks.count, deleteMany: mocks.deleteMany },
  webhookDelivery: { count: mocks.count, deleteMany: mocks.deleteMany },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue({ ...row });
  mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data }));
  mocks.remove.mockResolvedValue({ ...row });
  mocks.findMany.mockResolvedValue([]);
  mocks.updateMany.mockResolvedValue({ count: 0 });
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.count.mockResolvedValue(0);
  mocks.transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
});

describe("application credential rotation", () => {
  it("rotates the three secrets and stores only the hash and ciphertext", async () => {
    const credentials = await rotateApplicationCredentials("app_row_1");

    expect(credentials.apiKey.startsWith("txp_app_matrix_")).toBe(true);
    expect(credentials.webhookSecret.startsWith("whsec_")).toBe(true);
    expect(credentials.epayKey.length).toBeGreaterThanOrEqual(32);

    const [[payload]] = mocks.update.mock.calls as Array<[{ where: { id: string }; data: Record<string, string> }]>;
    expect(payload!.where).toEqual({ id: "app_row_1" });
    expect(payload!.data.apiKeyHash).toBe(sha256(credentials.apiKey));
    expect(openSealed(payload!.data.webhookSecretEncrypted!)).toBe(credentials.webhookSecret);
    expect(openSealed(payload!.data.epayKeyEncrypted!)).toBe(credentials.epayKey);
    expect(payload!.data.webhookSecretEncrypted).not.toContain(credentials.webhookSecret);
    // PID 是商户标识而不是密钥，不参与轮换。
    expect(payload!.data.epayPid).toBeUndefined();
    expect(payload!.data.status).toBeUndefined();
  });

  it("issues a different key on every rotation", async () => {
    const first = await rotateApplicationCredentials("app_row_1");
    const second = await rotateApplicationCredentials("app_row_1");
    expect(second.apiKey).not.toBe(first.apiKey);
    expect(second.webhookSecret).not.toBe(first.webhookSecret);
    expect(second.epayKey).not.toBe(first.epayKey);
  });

  it("rejects unknown applications", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(rotateApplicationCredentials("missing")).rejects.toMatchObject({ code: "APPLICATION_NOT_FOUND", status: 404 });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("application status changes", () => {
  it("persists an ACTIVE to DISABLED transition", async () => {
    await updateApplicationStatus("app_row_1", "DISABLED");
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "app_row_1" }, data: { status: "DISABLED" } });
  });

  it("skips the write when the status is unchanged", async () => {
    await updateApplicationStatus("app_row_1", "ACTIVE");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses to touch the internal channel diagnostics application", async () => {
    mocks.findUnique.mockResolvedValue({ ...row, appId: INTERNAL_APPLICATION_ID });
    await expect(updateApplicationStatus("app_row_1", "DISABLED")).rejects.toMatchObject({ code: "APPLICATION_INTERNAL", status: 409 });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("application deletion", () => {
  const counts = (orders: number, refunds: number, webhookDeliveries: number) => ({ ...row, _count: { orders, refunds, webhookDeliveries } });

  it("deletes the row outright when the application never carried business data", async () => {
    mocks.findUnique.mockResolvedValue(counts(0, 0, 0));
    await expect(deleteApplication("app_row_1")).resolves.toEqual({
      appId: "app_matrix", name: "TUOXIN Matrix", archived: false,
      cleared: { orders: 0, payments: 0, refunds: 0, events: 0, webhookDeliveries: 0, exceptions: 0, receipts: 0 },
    });
    expect(mocks.remove).toHaveBeenCalledWith({ where: { id: "app_row_1" } });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("archives instead of refusing once orders exist", async () => {
    mocks.findUnique.mockResolvedValue(counts(3, 0, 0));
    // findMany 第一次调用是取待归档订单，其余三次（回执/保留支付/保留退款）都返回空。
    mocks.findMany.mockResolvedValueOnce([{ id: "ord_1" }, { id: "ord_2" }, { id: "ord_3" }]).mockResolvedValue([]);
    const result = await deleteApplication("app_row_1");
    expect(result).toMatchObject({ appId: "app_matrix", archived: true });
    expect((result as { cleared: { orders: number } }).cleared.orders).toBe(3);
    // 行必须留下：订单、退款、通知投递都还挂在它上面，删行会被外键拦住、也会丢掉追溯能力。
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["ord_1", "ord_2", "ord_3"] } },
      data: { deletedAt: expect.any(Date), deletedWithApplicationId: "app_matrix" },
    });
  });

  it("clears credentials and marks the archive timestamp", async () => {
    mocks.findUnique.mockResolvedValue(counts(0, 0, 2));
    await deleteApplication("app_row_1");
    const [[payload]] = mocks.update.mock.calls as Array<[{ where: { id: string }; data: Record<string, unknown> }]>;
    expect(payload!.where).toEqual({ id: "app_row_1" });
    expect(payload!.data.status).toBe("DISABLED");
    expect(payload!.data.archivedAt).toBeInstanceOf(Date);
    expect(payload!.data.pausedAt).toBeInstanceOf(Date);
    expect(payload!.data.webhookUrl).toBeNull();
    // 凭证不是清空而是重新随机：置空会让 sha256 校验路径拿到 undefined，重新随机则永远不可能被猜中。
    expect(payload!.data.apiKeyHash).not.toBe(row.apiKeyHash);
    expect(payload!.data.epayKeyEncrypted).not.toBe(row.epayKeyEncrypted);
  });

  it("keeps succeeded payments but drops the failed attempts", async () => {
    mocks.findUnique.mockResolvedValue(counts(1, 0, 0));
    // 归档事务里的 findMany 顺序：待归档订单 → 待清理回执 → 要保留的成功支付单 → 要保留的退款。
    // 用参数形状分派，不依赖调用次序，避免实现调整顺序时测试假失败。
    mocks.findMany.mockImplementation(async (args: { where: Record<string, any> }) => {
      if (args.where.deletedAt === null) return [{ id: "ord_1" }];
      if (args.where.status?.in?.includes("SUCCESS") && args.where.orderId) return [{ id: "pay_kept" }];
      return [];
    });
    await deleteApplication("app_row_1");
    // 成功/关闭的支付单保留行，失败的尝试删除；删除语句必须把保留项排除掉。
    const paymentDeletion = (mocks.deleteMany.mock.calls as Array<[{ where: { orderId?: unknown; id?: unknown } }]>)
      .map(([args]) => args.where)
      .find(where => where.orderId !== undefined);
    expect(paymentDeletion).toMatchObject({ orderId: { in: ["ord_1"] }, id: { notIn: ["pay_kept"] } });
  });

  it("archives when a foreign key appears between the count and the delete", async () => {
    mocks.findUnique.mockResolvedValue(counts(0, 0, 0));
    mocks.remove.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", { code: "P2003", clientVersion: "6.12.0" }));
    await expect(deleteApplication("app_row_1")).resolves.toMatchObject({ archived: true });
    expect(mocks.transaction).toHaveBeenCalled();
  });

  it("refuses to delete the internal channel diagnostics application", async () => {
    mocks.findUnique.mockResolvedValue({ ...counts(0, 0, 0), appId: INTERNAL_APPLICATION_ID });
    await expect(deleteApplication("app_row_1")).rejects.toMatchObject({ code: "APPLICATION_INTERNAL", status: 409 });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("reports missing applications as not found", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(deleteApplication("missing")).rejects.toMatchObject({ code: "APPLICATION_NOT_FOUND", status: 404 });
  });
});
