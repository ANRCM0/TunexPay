import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../db.js", () => ({ db: { webhookDelivery: { findMany: mocks.findMany } } }));

import { describeAdminAction } from "../middleware/admin-audit.js";
import { listDueDeliveryIds } from "../services/webhook-worker-service.js";

describe("admin audit actions for application lifecycle", () => {
  it("names application delete and archive actions", () => {
    expect(describeAdminAction("POST", "/admin/v1/applications/app_1/delete")).toEqual({
      action: "APPLICATION_DELETE", resourceType: "APPLICATION", resourceId: "app_1",
    });
    expect(describeAdminAction("POST", "/admin/v1/applications/app_1/archive")).toEqual({
      action: "APPLICATION_ARCHIVE", resourceType: "APPLICATION", resourceId: "app_1",
    });
  });
});

describe("webhook worker scoping", () => {
  it("never picks up deliveries whose order was archived", async () => {
    mocks.findMany.mockResolvedValue([]);
    await listDueDeliveryIds(50);
    // 归档应用的通知投递已经在归档事务里删掉了，这里再兜一层 order.deletedAt，
    // 防止 Worker 与归档事务抢跑，把已删应用的过期通知又发出去。
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "PENDING", order: { deletedAt: null } }),
    }));
  });
});
