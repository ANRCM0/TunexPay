export type RoutingStrategy = "RANDOM" | "WEIGHTED_RANDOM";
export type RoutingGroup = {
  id: string; name: string; strategy: RoutingStrategy; enabled: boolean; revision: number;
  createdAt: string; updatedAt: string; applicationCount: number; availableChannels: number;
  members: {
    channelId: string; weight: number; enabled: boolean; eligible: boolean;
    channel: { id: string; name: string; plugin: string; enabled: boolean; archivedAt: string | null; checkStatus: string };
  }[];
};
export const routingStrategyLabels: Record<RoutingStrategy, string> = { RANDOM: "等概率随机", WEIGHTED_RANDOM: "按权重随机" };
export const canAssignGroup = (group: RoutingGroup) => group.enabled && group.availableChannels > 0;
