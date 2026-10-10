import { randomInt } from "node:crypto";
import type { RoutingStrategy } from "@prisma/client";
import { AppError } from "./errors.js";

export function chooseRoutingMember<T extends { weight: number }>(
  members: readonly T[], strategy: RoutingStrategy, draw: (exclusiveMax: number) => number = randomInt,
): T {
  if (!members.length) throw new AppError("ROUTING_GROUP_NO_CHANNEL", "轮询组没有可用通道，请检查成员启用状态与通道检测结果", 409);
  const weights = members.map(member => strategy === "WEIGHTED_RANDOM" ? member.weight : 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (weights.some(weight => !Number.isSafeInteger(weight) || weight <= 0) || !Number.isSafeInteger(total)) {
    throw new AppError("ROUTING_WEIGHT_INVALID", "轮询组权重必须为正整数", 409);
  }
  let ticket = draw(total);
  for (let index = 0; index < members.length; index += 1) {
    if (ticket < weights[index]!) return members[index]!;
    ticket -= weights[index]!;
  }
  throw new AppError("ROUTING_DRAW_INVALID", "轮询组随机选路失败", 500);
}
