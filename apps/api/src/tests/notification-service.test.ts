import { beforeEach, describe, expect, it, vi } from "vitest";
import { seal } from "../lib/crypto.js";

const mocks = vi.hoisted(() => ({
  instanceFirst: vi.fn(), instanceFind: vi.fn(),
  deliveryUpdateMany: vi.fn(), deliveryFindMany: vi.fn(), deliveryUpsert: vi.fn(),
  eventFindMany: vi.fn(), seenFindOne: vi.fn(), seenCreate: vi.fn(), collectorFindMany: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../db.js", () => {
  const tx = {
    ownerNotificationDelivery: { upsert: mocks.deliveryUpsert },
    ownerNotificationSeen: { findUnique: mocks.seenFindOne, create: mocks.seenCreate },
    notificationInstance: { findMany: vi.fn(async () => []) },
  };
  return {
    db: {
      ...tx,
      notificationInstance: { findFirst: mocks.instanceFirst, findUnique: mocks.instanceFind },
      ownerNotificationDelivery: { findMany: mocks.deliveryFindMany, updateMany: mocks.deliveryUpdateMany, upsert: mocks.deliveryUpsert },
      paymentEvent: { findMany: mocks.eventFindMany },
      ownerNotificationSeen: { findUnique: mocks.seenFindOne, create: mocks.seenCreate },
      billCollectorState: { findMany: mocks.collectorFindMany },
      $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
    },
  };
});
vi.mock("../services/notification-instance-service.js", () => ({ ensureLegacyNotificationMigration: vi.fn(async () => undefined) }));
vi.mock("../notifications/plugins.js", () => ({ notificationPlugin: () => ({ send: mocks.send }) }));

import { runNotifications } from "../services/notification-service.js";

const payload = seal(JSON.stringify({ url: "https://example.com/hook", secret: "" }));
const instance = { id: "notify-webhook", plugin: "WEBHOOK", enabled: true, archivedAt: null, payloadEncrypted: payload };
const task = (id: string, attempts = 0) => ({ id, instanceId: id, attempts, title: "title", message: "body", eventType: "ORDER_SUCCEEDED", payload: null, channel: "WEBHOOK" });

/** Calls that carry a task id are the per-task claim / final state transitions. */
const transitions = () => mocks.deliveryUpdateMany.mock.calls
  .filter(([input]: [{ where?: { id?: string } }]) => Boolean(input.where?.id))
  .map(([input]: [{ where: { id: string }; data: Record<string, unknown> }]) => ({ id: input.where.id, data: input.data }));

const finalState = (id: string) => transitions().filter(item => item.id === id).at(-1)?.data;

describe("notification delivery pump", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.instanceFirst.mockResolvedValue(null);
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.collectorFindMany.mockResolvedValue([]);
    mocks.deliveryFindMany.mockResolvedValue([]);
    mocks.deliveryUpdateMany.mockImplementation(async (input: { where?: { id?: string } }) => (input.where?.id ? { count: 1 } : { count: 0 }));
    mocks.instanceFind.mockResolvedValue(instance);
    mocks.send.mockResolvedValue(undefined);
  });

  it("cancels queued tasks when the instance is disabled or archived", async () => {
    mocks.instanceFind.mockResolvedValue({ ...instance, enabled: false });
    mocks.deliveryFindMany.mockResolvedValue([task("disabled")]);
    await runNotifications();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(finalState("disabled")).toMatchObject({ status: "CANCELLED", lockedUntil: null, leaseOwner: null });
  });

  it("cancels queued tasks when the instance row is gone", async () => {
    mocks.instanceFind.mockResolvedValue(null);
    mocks.deliveryFindMany.mockResolvedValue([task("missing")]);
    await runNotifications();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(finalState("missing")).toMatchObject({ status: "CANCELLED" });
  });

  it("marks a task dead after the fifth failed attempt without leaking sender errors", async () => {
    mocks.deliveryFindMany.mockResolvedValue([task("mail", 4)]);
    mocks.send.mockRejectedValue(new Error("sensitive password must not leak"));
    await runNotifications();
    const data = finalState("mail")!;
    expect(data).toMatchObject({ status: "DEAD", lastError: "SEND_FAILED_CHECK_PLUGIN_CONFIG", lockedUntil: null, leaseOwner: null });
    expect(JSON.stringify(data)).not.toContain("sensitive password must not leak");
  });

  it("retries a failed send and schedules the next attempt without blocking other tasks", async () => {
    mocks.deliveryFindMany.mockResolvedValue([task("failing"), task("healthy")]);
    mocks.send.mockImplementation(async (_input: unknown, config: { url?: string }) => {
      if (config.url === "https://failing.example/hook") throw new Error("boom");
    });
    mocks.instanceFind.mockImplementation(async ({ where }: { where: { id: string } }) => where.id === "failing" ? { ...instance, id: "failing", payloadEncrypted: seal(JSON.stringify({ url: "https://failing.example/hook" })) } : instance);
    await runNotifications();
    expect(finalState("failing")).toMatchObject({ status: "PENDING", lastError: "SEND_FAILED_CHECK_PLUGIN_CONFIG" });
    expect(finalState("failing")!.nextAttemptAt).toBeInstanceOf(Date);
    expect(finalState("healthy")).toMatchObject({ status: "SUCCESS", lastError: null });
  });

  it("only claims deliveries that are bound to a notification instance", async () => {
    mocks.deliveryFindMany.mockResolvedValue([task("bound")]);
    await runNotifications();
    expect(mocks.deliveryFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ instanceId: { not: null } }),
    }));
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("skips event collection entirely when no instance exists yet", async () => {
    await runNotifications();
    expect(mocks.eventFindMany).not.toHaveBeenCalled();
  });
});
