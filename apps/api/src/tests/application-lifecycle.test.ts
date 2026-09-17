import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn(), remove: vi.fn() }));

vi.mock("../db.js", () => ({
  db: { application: { findUnique: mocks.findUnique, update: mocks.update, delete: mocks.remove } },
}));
// 应用生命周期只碰 application 表，通道校验在本用例里不需要真实实现。
vi.mock("../services/channel-instance-service.js", () => ({ loadChannel: vi.fn(), assertChannelVerified: vi.fn() }));

import { deleteApplication, INTERNAL_APPLICATION_ID, rotateApplicationCredentials, updateApplicationStatus } from "../services/application-service.js";
import { openSealed, sha256 } from "../lib/crypto.js";

const row = { id: "app_row_1", appId: "app_matrix", name: "TUOXIN Matrix", epayPid: "1234567890", status: "ACTIVE" as const, apiKeyHash: "hash", webhookSecretEncrypted: "sealed", epayKeyEncrypted: "sealed" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue({ ...row });
  mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data }));
  mocks.remove.mockResolvedValue({ ...row });
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

  it("deletes an application that never carried business data", async () => {
    mocks.findUnique.mockResolvedValue(counts(0, 0, 0));
    await expect(deleteApplication("app_row_1")).resolves.toEqual({ appId: "app_matrix", name: "TUOXIN Matrix" });
    expect(mocks.remove).toHaveBeenCalledWith({ where: { id: "app_row_1" } });
  });

  it("refuses to delete while orders exist and reports the blocking counts", async () => {
    mocks.findUnique.mockResolvedValue(counts(3, 1, 2));
    await expect(deleteApplication("app_row_1")).rejects.toMatchObject({ code: "APPLICATION_HAS_BUSINESS_DATA", status: 409 });
    await expect(deleteApplication("app_row_1")).rejects.toThrow(/订单 3 笔、退款 1 笔、通知投递 2 条/);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses to delete when only notification deliveries exist", async () => {
    mocks.findUnique.mockResolvedValue(counts(0, 0, 5));
    await expect(deleteApplication("app_row_1")).rejects.toMatchObject({ code: "APPLICATION_HAS_BUSINESS_DATA", status: 409 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("turns a foreign key rejection into the same readable conflict", async () => {
    mocks.findUnique.mockResolvedValue(counts(0, 0, 0));
    mocks.remove.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", { code: "P2003", clientVersion: "6.12.0" }));
    await expect(deleteApplication("app_row_1")).rejects.toMatchObject({ code: "APPLICATION_HAS_BUSINESS_DATA", status: 409 });
  });

  it("refuses to delete the internal channel diagnostics application", async () => {
    mocks.findUnique.mockResolvedValue({ ...counts(0, 0, 0), appId: INTERNAL_APPLICATION_ID });
    await expect(deleteApplication("app_row_1")).rejects.toMatchObject({ code: "APPLICATION_INTERNAL", status: 409 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("reports missing applications as not found", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(deleteApplication("missing")).rejects.toMatchObject({ code: "APPLICATION_NOT_FOUND", status: 404 });
  });
});
