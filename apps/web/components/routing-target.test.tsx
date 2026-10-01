import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicationRoutingTarget, assignPaymentRouting, routingCreateInput, RoutingTargetSelect } from "./routing-target";
import { canAssignGroup, type RoutingGroup } from "../lib/routing-groups";
import type { Channel } from "./channels";
const group = { id: "grp-1", name: "主收款组", strategy: "RANDOM", enabled: true, availableChannels: 2 } as RoutingGroup;
const channel = { id: "account-a", name: "账号 A", enabled: true, checkStatus: "API_VERIFIED" } as Channel;
afterEach(() => { vi.unstubAllGlobals(); });
describe("routing target selection", () => {
  it("shows groups and compatible single-channel bindings separately", () => {
    const html = renderToStaticMarkup(<RoutingTargetSelect aria-label="收款路由" groups={[group]} channels={[channel]} />);
    expect(html).toContain('aria-label="收款路由"');
    expect(html).toContain('label="轮询组"'); expect(html).toContain('label="单通道（兼容原配置）"');
    expect(html).toContain('value="group:grp-1"'); expect(html).toContain('value="channel:account-a"');
  });
  it("disables groups without eligible channels", () => {
    const html = renderToStaticMarkup(<RoutingTargetSelect groups={[{ ...group, availableChannels: 0 }]} channels={[]} />);
    expect(html).toMatch(/<option[^>]*value="group:grp-1"[^>]*disabled/);
    expect(canAssignGroup({ ...group, enabled: false })).toBe(false);
  });
  it("preserves an unavailable current binding as an explicit option", () => {
    const html = renderToStaticMarkup(<RoutingTargetSelect groups={[]} channels={[]} currentTarget="group:removed" value="group:removed" onChange={() => undefined} />);
    expect(html).toContain('value="group:removed"'); expect(html).toContain("原收款路由");
  });
  it("prefers group binding over the legacy channel", () => {
    expect(applicationRoutingTarget({ routingGroupId: "grp-1", defaultChannelId: "account-a" })).toBe("group:grp-1");
    expect(applicationRoutingTarget({ defaultChannelId: "account-a" })).toBe("channel:account-a");
    expect(applicationRoutingTarget({ defaultChannelId: null })).toBe("");
  });
  it("creates mutually exclusive group and channel inputs", () => {
    expect(routingCreateInput("group:grp-1")).toEqual({ routingGroupId: "grp-1" });
    expect(routingCreateInput("channel:account-a")).toEqual({ defaultChannelId: "account-a" });
    expect(routingCreateInput("")).toEqual({});
  });
  it.each([
    ["group:grp-1", "/applications/app-1/routing-group", { groupId: "grp-1" }],
    ["channel:account-a", "/applications/app-1/channel-instance", { channelId: "account-a" }],
    ["", "/applications/app-1/routing-group", { groupId: null }],
  ])("assigns target %s through the correct authenticated BFF path", async (target, path, body) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await assignPaymentRouting("app-1", target as string);
    expect(fetchMock).toHaveBeenCalledWith(`/api/backend${path}`, expect.objectContaining({ method: "POST", body: JSON.stringify(body) }));
  });
});
