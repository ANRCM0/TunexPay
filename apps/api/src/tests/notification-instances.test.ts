import { beforeEach, describe, expect, it, vi } from "vitest";
import { seal } from "../lib/crypto.js";

const mocks = vi.hoisted(() => ({
  raw: vi.fn(), instanceFind: vi.fn(), instanceUpdate: vi.fn(), instanceCreate: vi.fn(),
  subscriptionUpsert: vi.fn(), deliveryFindFirst: vi.fn(), deliveryCreate: vi.fn(),
  normalizeConfig: vi.fn((raw: unknown) => raw as Record<string, unknown>), publicConfig: vi.fn((config: unknown) => config as Record<string, unknown>),
}));

vi.mock("../db.js", () => {
  const tx = {
    $queryRaw: mocks.raw,
    notificationInstance: { findUnique: mocks.instanceFind, update: mocks.instanceUpdate, create: mocks.instanceCreate },
    notificationSubscription: { upsert: mocks.subscriptionUpsert },
    ownerNotificationDelivery: { findFirst: mocks.deliveryFindFirst, create: mocks.deliveryCreate },
  };
  return { db: { ...tx, $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx) } };
});
vi.mock("../notifications/plugins.js", () => ({
  notificationPlugin: () => ({ normalizeConfig: mocks.normalizeConfig, publicConfig: mocks.publicConfig }),
  notificationPluginCatalog: () => [],
}));

import { saveNotificationInstance, testNotificationInstance } from "../services/notification-instance-service.js";

const row = {
  id: "notify-webhook", plugin: "WEBHOOK", name: "通知", enabled: true, revision: 3,
  payloadEncrypted: seal(JSON.stringify({ url: "https://example.com/hook", secret: "s" })),
  archivedAt: null, createdAt: new Date(), updatedAt: new Date(), subscriptions: [],
};

describe("notification instance writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.instanceFind.mockResolvedValue({ ...row });
    mocks.normalizeConfig.mockImplementation((raw: unknown) => raw as Record<string, unknown>);
  });

  it("rejects a stale revision without writing", async () => {
    await expect(saveNotificationInstance(row.id, { name: "x", plugin: "WEBHOOK", enabled: true, revision: 1, config: {} }))
      .rejects.toMatchObject({ code: "NOTIFICATION_CONFIG_CONFLICT" });
    expect(mocks.instanceUpdate).not.toHaveBeenCalled();
    expect(mocks.raw).toHaveBeenCalled();
  });

  it("rejects swapping the plugin of an existing instance", async () => {
    await expect(saveNotificationInstance(row.id, { name: "x", plugin: "SMTP", enabled: true, revision: 3, config: {} }))
      .rejects.toMatchObject({ code: "NOTIFICATION_PLUGIN_IMMUTABLE" });
    expect(mocks.instanceUpdate).not.toHaveBeenCalled();
  });

  it("does not touch archived instances", async () => {
    mocks.instanceFind.mockResolvedValue({ ...row, archivedAt: new Date() });
    await expect(saveNotificationInstance(row.id, { name: "x", plugin: "WEBHOOK", enabled: true, revision: 3, config: {} }))
      .rejects.toMatchObject({ code: "NOTIFICATION_INSTANCE_NOT_FOUND" });
    expect(mocks.instanceUpdate).not.toHaveBeenCalled();
  });

  it("refuses to test a disabled instance", async () => {
    mocks.instanceFind.mockResolvedValue({ ...row, enabled: false });
    await expect(testNotificationInstance(row.id)).rejects.toMatchObject({ code: "NOTIFICATION_DISABLED" });
    expect(mocks.deliveryCreate).not.toHaveBeenCalled();
  });

  it("rate-limits test notifications per instance and otherwise queues a bound test delivery", async () => {
    mocks.deliveryFindFirst.mockResolvedValue({ id: "recent" });
    await expect(testNotificationInstance(row.id)).rejects.toMatchObject({ code: "TEST_RATE_LIMIT" });
    expect(mocks.deliveryCreate).not.toHaveBeenCalled();

    mocks.deliveryFindFirst.mockResolvedValue(null);
    mocks.deliveryCreate.mockResolvedValue({ id: "delivery-1" });
    await testNotificationInstance(row.id);
    expect(mocks.deliveryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ instanceId: row.id, channel: "WEBHOOK", eventType: "TEST" }),
    }));
  });
});
