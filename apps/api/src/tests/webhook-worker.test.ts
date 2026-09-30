import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn() }));

vi.mock("../db.js", () => ({
  db: { webhookDelivery: { findMany: mocks.findMany, updateMany: mocks.updateMany } },
}));

import { isPrivateAddress } from "../lib/webhook-security.js";
import { recoverExpiredDeliveries, retryDelaySeconds } from "../services/webhook-worker-service.js";

describe("webhook delivery safety", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fd00::1"])("blocks private address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it("uses bounded exponential backoff", () => {
    expect(retryDelaySeconds(1, 0.5)).toBe(5);
    expect(retryDelaySeconds(2, 0.5)).toBe(10);
    expect(retryDelaySeconds(20, 0.5)).toBe(3600);
  });
});

// 停机重启后的第一跳不能一次更新掉所有过期租约，必须分批。
describe("recoverExpiredDeliveries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 0 });
  });

  it("caps one tick at the batch size and only touches those rows", async () => {
    mocks.findMany.mockResolvedValue(Array.from({ length: 100 }, (_, index) => ({ id: `wh_${index}` })));
    mocks.updateMany.mockResolvedValue({ count: 100 });

    expect(await recoverExpiredDeliveries()).toBe(100);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    const update = mocks.updateMany.mock.calls[0]![0];
    expect(update.where.id.in).toHaveLength(100);
    expect(update.data.status).toBe("PENDING");
    expect(update.data.lockedUntil).toBeNull();
  });

  it("skips the update entirely when nothing has expired", async () => {
    mocks.findMany.mockResolvedValue([]);
    expect(await recoverExpiredDeliveries()).toBe(0);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("honours a custom batch size", async () => {
    mocks.findMany.mockResolvedValue([{ id: "wh_1" }]);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    await recoverExpiredDeliveries(5);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5 }));
  });
});
