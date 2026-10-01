import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../lib/errors.js";
const mocks = vi.hoisted(() => ({
  raw: vi.fn(), groupFind: vi.fn(), groupList: vi.fn(), groupCreate: vi.fn(), groupUpdate: vi.fn(), groupDelete: vi.fn(), memberDelete: vi.fn(),
  channels: vi.fn(), channelFind: vi.fn(), appFind: vi.fn(), appCount: vi.fn(), appUpdate: vi.fn(), testFind: vi.fn(), verify: vi.fn(), choose: vi.fn(),
}));
vi.mock("../db.js", () => {
  const tx = {
    $queryRaw: mocks.raw,
    routingGroup: { findUnique: mocks.groupFind, findMany: mocks.groupList, create: mocks.groupCreate, update: mocks.groupUpdate, delete: mocks.groupDelete },
    routingGroupMember: { deleteMany: mocks.memberDelete },
    channelInstance: { findMany: mocks.channels, findUniqueOrThrow: mocks.channelFind },
    application: { findUnique: mocks.appFind, count: mocks.appCount, update: mocks.appUpdate }, payment: { findUnique: mocks.testFind },
  };
  return { db: { ...tx, $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) } };
});
vi.mock("../services/channel-instance-service.js", () => ({ assertChannelVerified: mocks.verify,
  verificationStatus: (row: { checkStatus: string }) => row.checkStatus,
}));
vi.mock("../lib/routing-selection.js", () => ({ chooseRoutingMember: mocks.choose }));
import { db } from "../db.js";
import { assignRoutingGroup, deleteRoutingGroup, listRoutingGroups, routingGroupInput, saveRoutingGroup, selectRoutingChannel } from "../services/routing-group-service.js";

type FixtureChannel = { id: string; plugin: string; name: string; enabled: boolean; archivedAt: Date | null; checkStatus: string; payloadEncrypted: string; revision: number };
const channel = (id: string, patch: Partial<FixtureChannel> = {}): FixtureChannel => ({ id, plugin: "ALIPAY", name: id, enabled: true, archivedAt: null, checkStatus: "API_VERIFIED", payloadEncrypted: "never-expose-this-secret", revision: 1, ...patch });
const member = (id: string, patch: Partial<FixtureChannel> = {}, enabled = true) => ({ groupId: "grp-1", channelId: id, weight: 2, enabled, channel: channel(id, patch) });
let group: { id: string; name: string; enabled: boolean; revision: number; strategy: "RANDOM" | "WEIGHTED_RANDOM"; members: ReturnType<typeof member>[]; _count: { applications: number } };
const input = () => ({ name: "主收款组", strategy: "RANDOM", enabled: true, members: [{ channelId: "account-a", weight: 1, enabled: true }] });

beforeEach(() => {
  vi.clearAllMocks();
  group = { id: "grp-1", name: "主收款组", enabled: true, revision: 2, strategy: "WEIGHTED_RANDOM", members: [member("account-a")], _count: { applications: 0 } };
  mocks.groupFind.mockImplementation(async () => group);
  mocks.groupList.mockImplementation(async () => [group]);
  mocks.groupCreate.mockImplementation(async () => group); mocks.groupUpdate.mockImplementation(async () => group);
  mocks.channels.mockResolvedValue([channel("account-a")]); mocks.channelFind.mockResolvedValue(channel("account-a"));
  mocks.appFind.mockResolvedValue({ id: "app-1", appId: "app-live", archivedAt: null }); mocks.appCount.mockResolvedValue(0);
  mocks.appUpdate.mockImplementation(async ({ data }: { data: object }) => ({ id: "app-1", ...data }));
  mocks.testFind.mockResolvedValue(null);
  mocks.verify.mockImplementation(async (row: FixtureChannel) => {
    if (row.checkStatus !== "API_VERIFIED") throw new AppError("CHANNEL_NOT_CHECKED", "检测不通过", 409);
  });
  mocks.choose.mockImplementation((members: unknown[]) => {
    if (!members.length) throw new AppError("ROUTING_GROUP_NO_CHANNEL", "没有可用通道", 409);
    return members[0];
  });
});

describe("routing group configuration", () => {
  it("defaults to equal random and unit weights", () => {
    expect(routingGroupInput.parse({ name: "组", members: [{ channelId: "a" }] })).toMatchObject({ strategy: "RANDOM", enabled: true, members: [{ weight: 1, enabled: true }] });
  });
  it.each([
    { ...input(), members: [] },
    { ...input(), members: [{ channelId: "a" }, { channelId: "a" }] },
    { ...input(), members: [{ channelId: "a", weight: 0 }] },
    { ...input(), members: [{ channelId: "a", weight: 10_001 }] },
    { ...input(), members: Array.from({ length: 101 }, (_, id) => ({ channelId: String(id) })) },
    { ...input(), strategy: "ROUND_ROBIN" },
  ])("rejects invalid group configuration", value => { expect(routingGroupInput.safeParse(value).success).toBe(false); });
  it("creates group and members atomically without returning secrets", async () => {
    const result = await saveRoutingGroup(input());
    expect(mocks.groupCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ members: { create: input().members } }) }));
    expect(result.availableChannels).toBe(1);
    expect(JSON.stringify(result)).not.toContain("never-expose-this-secret");
    expect(JSON.stringify(result)).not.toContain("payloadEncrypted");
  });
  it("replaces members and increments the revision on update", async () => {
    await saveRoutingGroup({ ...input(), revision: 2 }, group.id);
    expect(mocks.memberDelete).toHaveBeenCalledWith({ where: { groupId: "grp-1" } });
    expect(mocks.groupUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ revision: { increment: 1 } }) }));
  });
  it.each([undefined, 1])("refuses stale or absent revision %s before deleting members", async revision => {
    await expect(saveRoutingGroup({ ...input(), revision }, group.id)).rejects.toMatchObject({ code: "ROUTING_GROUP_CONFLICT" });
    expect(mocks.memberDelete).not.toHaveBeenCalled();
  });
  it("rejects non-existent groups", async () => {
    mocks.groupFind.mockResolvedValue(null);
    await expect(saveRoutingGroup({ ...input(), revision: 2 }, group.id)).rejects.toMatchObject({ code: "ROUTING_GROUP_NOT_FOUND" });
  });
  it.each([{ rows: [] }, { rows: [channel("account-a", { archivedAt: new Date() })] }])("rejects absent or archived channel membership", async ({ rows }) => {
    mocks.channels.mockResolvedValue(rows);
    await expect(saveRoutingGroup(input())).rejects.toMatchObject({ code: "ROUTING_MEMBER_INVALID" });
    expect(mocks.groupCreate).not.toHaveBeenCalled();
  });
  it("shows paused, disabled and unchecked members as unavailable", async () => {
    group.members = [member("good"), member("paused", {}, false), member("disabled", { enabled: false }), member("unchecked", { checkStatus: "UNCHECKED" })];
    const [result] = await listRoutingGroups();
    expect(result?.members.map(item => item.eligible)).toEqual([true, false, false, false]);
    expect(result?.availableChannels).toBe(1);
  });
  it("blocks deletion while a live application still uses the group", async () => {
    mocks.appCount.mockResolvedValue(1);
    await expect(deleteRoutingGroup(group.id, 2)).rejects.toMatchObject({ code: "ROUTING_GROUP_IN_USE" });
    expect(mocks.groupDelete).not.toHaveBeenCalled();
  });
  it("checks deletion revision", async () => {
    await expect(deleteRoutingGroup(group.id, 1)).rejects.toMatchObject({ code: "ROUTING_GROUP_CONFLICT" });
  });
  it("deletes an unbound group without touching any payments", async () => {
    expect(await deleteRoutingGroup(group.id, 2)).toEqual({ id: "grp-1", name: "主收款组" });
    expect(mocks.groupDelete).toHaveBeenCalledWith({ where: { id: "grp-1" } });
  });
});

describe("routing group selection", () => {
  it("only draws among eligible members and passes the configured strategy", async () => {
    group.members = [member("disabled", { enabled: false }), member("archived", { archivedAt: new Date() }), member("paused", {}, false), member("unchecked", { checkStatus: "UNCHECKED" }), member("account-a")];
    const result = await selectRoutingChannel(db as never, group.id);
    expect(result.channel.id).toBe("account-a");
    expect(mocks.choose).toHaveBeenCalledWith([group.members[4]], "WEIGHTED_RANDOM");
  });
  it("supports optional plugin filtering without selecting outside the group", async () => {
    group.members = [member("bill", { plugin: "ALIPAY_BILL" }), member("account-a")];
    await selectRoutingChannel(db as never, group.id, "ALIPAY");
    expect(mocks.choose).toHaveBeenCalledWith([group.members[1]], group.strategy);
  });
  it("fails when no eligible plugin remains", async () => {
    await expect(selectRoutingChannel(db as never, group.id, "MOCK")).rejects.toMatchObject({ code: "ROUTING_GROUP_NO_CHANNEL" });
    expect(mocks.channelFind).not.toHaveBeenCalled();
  });
  it("refuses disabled groups before drawing", async () => {
    group.enabled = false;
    await expect(selectRoutingChannel(db as never, group.id)).rejects.toMatchObject({ code: "ROUTING_GROUP_DISABLED" });
    expect(mocks.choose).not.toHaveBeenCalled();
  });
  it("refuses missing groups rather than falling back", async () => {
    mocks.groupFind.mockResolvedValue(null);
    await expect(selectRoutingChannel(db as never, group.id)).rejects.toMatchObject({ code: "ROUTING_GROUP_NOT_FOUND" });
  });
  it("does not hide database failures as no available channel", async () => {
    mocks.verify.mockRejectedValue(new Error("database disconnected"));
    await expect(selectRoutingChannel(db as never, group.id)).rejects.toThrow("database disconnected");
    expect(mocks.choose).not.toHaveBeenCalled();
  });
  it("rechecks the selected channel under its row lock", async () => {
    mocks.channelFind.mockResolvedValue(channel("account-a", { enabled: false }));
    await expect(selectRoutingChannel(db as never, group.id)).rejects.toMatchObject({ code: "ROUTING_CHANNEL_CHANGED" });
    expect(mocks.choose).toHaveBeenCalledTimes(1);
  });
  it("rejects newly invalid verification evidence after selection", async () => {
    mocks.channelFind.mockResolvedValue(channel("account-a", { checkStatus: "FAILED" }));
    await expect(selectRoutingChannel(db as never, group.id)).rejects.toMatchObject({ code: "CHANNEL_NOT_CHECKED" });
  });
});

describe("application routing group binding", () => {
  it("binds a group and clears the legacy direct channel", async () => {
    expect(await assignRoutingGroup("app-1", group.id)).toMatchObject({ routingGroupId: "grp-1", defaultChannelId: null });
    expect(mocks.appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { routingGroupId: "grp-1", defaultChannelId: null } }));
  });
  it("unbinds without silently restoring the old channel", async () => {
    expect(await assignRoutingGroup("app-1", null)).toMatchObject({ routingGroupId: null, defaultChannelId: null });
    expect(mocks.groupFind).not.toHaveBeenCalled();
  });
  it("requires a group with an available member", async () => {
    group.members[0]!.enabled = false;
    await expect(assignRoutingGroup("app-1", group.id)).rejects.toMatchObject({ code: "ROUTING_GROUP_NO_CHANNEL" });
    expect(mocks.appUpdate).not.toHaveBeenCalled();
  });
  it("cannot bind an archived application", async () => {
    mocks.appFind.mockResolvedValue({ appId: "app-live", archivedAt: new Date() });
    await expect(assignRoutingGroup("app-1", group.id)).rejects.toMatchObject({ code: "APPLICATION_NOT_FOUND" });
  });
  it("keeps channel diagnostic payments pinned to a single channel", async () => {
    mocks.appFind.mockResolvedValue({ appId: "channel-diagnostics", archivedAt: null });
    await expect(assignRoutingGroup("app-1", group.id)).rejects.toMatchObject({ code: "APPLICATION_INTERNAL" });
  });
});
