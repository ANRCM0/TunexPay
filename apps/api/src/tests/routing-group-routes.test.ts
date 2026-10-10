import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn(), assign: vi.fn() }));
vi.mock("../services/routing-group-service.js", () => ({ listRoutingGroups: mocks.list, saveRoutingGroup: mocks.save,
  deleteRoutingGroup: mocks.remove, assignRoutingGroup: mocks.assign, requireAssignableRoutingGroup: vi.fn(), selectRoutingChannel: vi.fn(),
}));
vi.mock("../middleware/admin-audit.js", () => ({ adminAudit: async (_c: unknown, next: () => Promise<void>) => next() }));
import { app } from "../app.js";
import { config } from "../config.js";

function request(path: string, body?: object, authenticated = true) {
  return app.request(`/admin/v1${path}`, { method: body ? "POST" : "GET",
    headers: { ...(authenticated ? { authorization: `Bearer ${config().ADMIN_TOKEN}` } : {}), "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.list.mockResolvedValue([{ id: "grp-1" }]); mocks.save.mockResolvedValue({ id: "grp-1" });
  mocks.remove.mockResolvedValue({ id: "grp-1" }); mocks.assign.mockResolvedValue({ id: "app-1", routingGroupId: "grp-1" });
});
describe("admin routing group routes", () => {
  it.each([undefined, { name: "组", members: [{ channelId: "a" }] }])("requires admin authentication for read and write", async body => {
    const response = await request("/routing-groups", body, false);
    expect(response.status).toBe(401); expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("lists configured routing groups", async () => {
    const response = await request("/routing-groups"); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: "grp-1" }] });
  });
  it("creates a routing group", async () => {
    const input = { name: "组", members: [{ channelId: "a" }] };
    const response = await request("/routing-groups", input);
    expect(response.status).toBe(201); expect(mocks.save).toHaveBeenCalledWith(input);
  });
  it("updates a named routing group", async () => {
    const input = { name: "组", revision: 1, members: [{ channelId: "a" }] };
    expect((await request("/routing-groups/grp-1", input)).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(input, "grp-1");
  });
  it("deletes with the expected revision", async () => {
    expect((await request("/routing-groups/grp-1/delete", { revision: 2 })).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith("grp-1", 2);
  });
  it.each([{}, { revision: 0 }, { revision: "2" }])("rejects malformed delete inputs", async body => {
    expect((await request("/routing-groups/grp-1/delete", body)).status).toBe(422); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it.each(["grp-1", null])("binds or unbinds application routing with %s", async groupId => {
    expect((await request("/applications/app-1/routing-group", { groupId })).status).toBe(200);
    expect(mocks.assign).toHaveBeenCalledWith("app-1", groupId);
  });
  it.each([{}, { groupId: "" }, { groupId: "grp-1", channelId: "a" }])("rejects ambiguous binding inputs", async body => {
    expect((await request("/applications/app-1/routing-group", body)).status).toBe(422); expect(mocks.assign).not.toHaveBeenCalled();
  });
});
