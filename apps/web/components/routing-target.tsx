"use client";
import type { SelectHTMLAttributes } from "react";
import type { Channel } from "./channels";
import { api } from "../lib/api";
import { canAssignGroup, routingStrategyLabels, type RoutingGroup } from "../lib/routing-groups";

type RoutingTargetProps = SelectHTMLAttributes<HTMLSelectElement> & {
  groups: RoutingGroup[]; channels: Channel[]; currentTarget?: string;
};

/** 用带类型前缀的选项避免组 ID 与通道 ID 混淆；单通道绑定（channel: 前缀）同样受支持。 */
export function RoutingTargetSelect({ groups, channels, currentTarget, ...props }: RoutingTargetProps) {
  const found = !currentTarget || groups.some(group => `group:${group.id}` === currentTarget)
    || channels.some(channel => `channel:${channel.id}` === currentTarget);
  return <select {...props}>
    <option value="">未绑定收款路由</option>
    {!found && <option value={currentTarget} disabled>原收款路由（不可用或待加载）</option>}
    <optgroup label="轮询组">
      {groups.map(group => <option key={group.id} value={`group:${group.id}`} disabled={!canAssignGroup(group)}>
        {group.name} · {routingStrategyLabels[group.strategy]} · {group.availableChannels} 个可用{!group.enabled ? " · 已停用" : ""}
      </option>)}
    </optgroup>
    <optgroup label="单通道（兼容原配置）">
      {channels.map(channel => <option key={channel.id} value={`channel:${channel.id}`} disabled={!!channel.archivedAt || !channel.enabled || !["API_VERIFIED", "PAYMENT_VERIFIED", "SIMULATED"].includes(channel.checkStatus)}>
        {channel.name}{!channel.enabled ? " · 已停用" : ""}
      </option>)}
    </optgroup>
  </select>;
}

export function applicationRoutingTarget(application: { routingGroupId?: string | null; defaultChannelId: string | null }) {
  return application.routingGroupId ? `group:${application.routingGroupId}` : application.defaultChannelId ? `channel:${application.defaultChannelId}` : "";
}

export function routingCreateInput(target: string) {
  if (target.startsWith("group:")) return { routingGroupId: target.slice(6) };
  if (target.startsWith("channel:")) return { defaultChannelId: target.slice(8) };
  return {};
}

export async function assignPaymentRouting(applicationId: string, target: string) {
  if (target.startsWith("channel:")) return api(`/applications/${applicationId}/channel-instance`, { method: "POST", body: JSON.stringify({ channelId: target.slice(8) }) });
  return api(`/applications/${applicationId}/routing-group`, { method: "POST", body: JSON.stringify({ groupId: target.startsWith("group:") ? target.slice(6) : null }) });
}
