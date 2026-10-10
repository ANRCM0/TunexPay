import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ group: vi.fn(), create: vi.fn(), channel: vi.fn(), verify: vi.fn() }));
vi.mock("../db.js", () => {
  const tx = { application: { create: mocks.create } };
  return { db: { ...tx, $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) } };
});
vi.mock("../services/routing-group-service.js", () => ({ requireAssignableRoutingGroup: mocks.group }));
vi.mock("../services/channel-instance-service.js", () => ({ loadChannel: mocks.channel, assertChannelVerified: mocks.verify }));
import { createApplication } from "../services/application-service.js";
import { AppError } from "../lib/errors.js";
beforeEach(() => {
  vi.clearAllMocks(); mocks.group.mockResolvedValue({ id: "grp-1" });
  mocks.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "app-row", ...data }));
});
describe("application creation with routing groups", () => {
  it("validates group and saves its binding in the application transaction", async () => {
    const result = await createApplication({ name: "业务应用", routingGroupId: "grp-1" });
    expect(mocks.group).toHaveBeenCalledWith(expect.anything(), "grp-1");
    expect(mocks.channel).not.toHaveBeenCalled();
    expect(result.application).toMatchObject({ routingGroupId: "grp-1" });
    expect(result.application.defaultChannelId).toBeUndefined();
    expect(result.credentials.apiKey).toMatch(/^txp_app_/);
  });
  it("refuses ambiguous group and single-channel creation", async () => {
    await expect(createApplication({ name: "应用", routingGroupId: "grp-1", defaultChannelId: "account-a" })).rejects.toMatchObject({ code: "APPLICATION_ROUTING_CONFLICT" });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.channel).not.toHaveBeenCalled();
  });
  it("does not create an application when its group is unavailable", async () => {
    mocks.group.mockRejectedValue(new AppError("ROUTING_GROUP_NO_CHANNEL", "没有可用通道", 409));
    await expect(createApplication({ name: "应用", routingGroupId: "grp-1" })).rejects.toMatchObject({ code: "ROUTING_GROUP_NO_CHANNEL" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
