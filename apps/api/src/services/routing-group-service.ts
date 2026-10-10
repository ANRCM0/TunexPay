import { Prisma, type ChannelInstance, type PaymentChannelCode } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.js";
import { AppError } from "../lib/errors.js";
import { chooseRoutingMember } from "../lib/routing-selection.js";
import { assertChannelVerified, verificationStatus } from "./channel-instance-service.js";

type Tx = Prisma.TransactionClient;
const groupInclude = {
  members: { include: { channel: true }, orderBy: { channelId: "asc" as const } },
  _count: { select: { applications: { where: { archivedAt: null } } } },
};
type Group = Prisma.RoutingGroupGetPayload<{ include: typeof groupInclude }>;

export const routingGroupInput = z.object({
  name: z.string().trim().min(1).max(120),
  strategy: z.enum(["RANDOM", "WEIGHTED_RANDOM"]).default("RANDOM"),
  enabled: z.boolean().default(true),
  revision: z.number().int().positive().optional(),
  members: z.array(z.object({
    channelId: z.string().trim().min(1).max(80),
    weight: z.number().int().min(1).max(10_000).default(1),
    enabled: z.boolean().default(true),
  }).strict()).min(1).max(100),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.members.map(member => member.channelId)).size !== input.members.length) {
    ctx.addIssue({ code: "custom", path: ["members"], message: "轮询组不能重复添加同一通道" });
  }
});

/** 管理列表只暴露通道摘要，不返回密钥、加密配置或支付 payload。 */
async function presentGroup(group: Group) {
  const members = await Promise.all(group.members.map(async member => {
    const channel = member.channel;
    const test = channel.testPaymentNo ? await db.payment.findUnique({
      where: { paymentNo: channel.testPaymentNo }, select: { channelId: true, status: true, paidAt: true },
    }) : null;
    const checkStatus = verificationStatus(channel, test);
    const eligible = member.enabled && channel.enabled && !channel.archivedAt
      && ["API_VERIFIED", "PAYMENT_VERIFIED", "SIMULATED"].includes(checkStatus);
    return { channelId: member.channelId, weight: member.weight, enabled: member.enabled, eligible,
      channel: { id: channel.id, name: channel.name, plugin: channel.plugin, enabled: channel.enabled, archivedAt: channel.archivedAt, checkStatus } };
  }));
  return { id: group.id, name: group.name, strategy: group.strategy, enabled: group.enabled, revision: group.revision,
    createdAt: group.createdAt, updatedAt: group.updatedAt, applicationCount: group._count.applications,
    availableChannels: members.filter(member => member.eligible).length, members };
}

export async function listRoutingGroups() {
  const groups = await db.routingGroup.findMany({ include: groupInclude, orderBy: { createdAt: "desc" } });
  return Promise.all(groups.map(presentGroup));
}

/** 配置与成员原子更新；修改现有组必须提交当前版本号。 */
export async function saveRoutingGroup(raw: unknown, id?: string) {
  const input = routingGroupInput.parse(raw);
  const group = await db.$transaction(async tx => {
    if (id) {
      await tx.$queryRaw`SELECT id FROM routing_groups WHERE id = ${id} FOR UPDATE`;
      const current = await tx.routingGroup.findUnique({ where: { id } });
      if (!current) throw new AppError("ROUTING_GROUP_NOT_FOUND", "轮询组不存在，请刷新后重新分配", 404);
      if (input.revision !== current.revision) throw new AppError("ROUTING_GROUP_CONFLICT", "轮询组已被修改，请刷新后重新保存", 409);
    }
    const channels = await tx.channelInstance.findMany({ where: { id: { in: input.members.map(member => member.channelId) } } });
    if (channels.length !== input.members.length || channels.some(channel => channel.archivedAt)) {
      throw new AppError("ROUTING_MEMBER_INVALID", "不能添加不存在或已归档的通道，请刷新通道列表", 409);
    }
    const { revision: _revision, members, ...settings } = input;
    if (!id) return tx.routingGroup.create({ data: { ...settings, members: { create: members } }, include: groupInclude });
    await tx.routingGroupMember.deleteMany({ where: { groupId: id } });
    return tx.routingGroup.update({ where: { id }, data: { ...settings, revision: { increment: 1 }, members: { create: members } }, include: groupInclude });
  });
  return presentGroup(group);
}

export async function deleteRoutingGroup(id: string, revision: number) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM routing_groups WHERE id = ${id} FOR UPDATE`;
    const group = await tx.routingGroup.findUnique({ where: { id } });
    if (!group) throw new AppError("ROUTING_GROUP_NOT_FOUND", "轮询组不存在，请刷新后重新分配", 404);
    if (group.revision !== revision) throw new AppError("ROUTING_GROUP_CONFLICT", "轮询组已被修改，请刷新后重新保存", 409);
    const assigned = await tx.application.count({ where: { routingGroupId: id, archivedAt: null } });
    if (assigned) throw new AppError("ROUTING_GROUP_IN_USE", `仍有 ${assigned} 个应用绑定该轮询组，请先解除绑定或改派`, 409);
    await tx.routingGroup.delete({ where: { id } });
    return { id, name: group.name };
  });
}

/** 仅跳过预期的检测失败；数据库故障不得伪装成“无可用通道”。 */
async function availableMembers(tx: Tx, group: Group, plugin?: PaymentChannelCode) {
  const candidates = [] as Group["members"];
  for (const member of group.members) {
    if (!member.enabled || !member.channel.enabled || member.channel.archivedAt || (plugin && member.channel.plugin !== plugin)) continue;
    try { await assertChannelVerified(member.channel, tx); candidates.push(member); }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== "CHANNEL_NOT_CHECKED") throw error;
    }
  }
  return candidates;
}

/** 选路取得共享锁，配置、删除和应用分配取得排他锁。 */
export async function loadRoutingGroup(tx: Tx, id: string, exclusive = false) {
  if (exclusive) await tx.$queryRaw`SELECT id FROM routing_groups WHERE id = ${id} FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM routing_groups WHERE id = ${id} FOR SHARE`;
  const group = await tx.routingGroup.findUnique({ where: { id }, include: groupInclude });
  if (!group) throw new AppError("ROUTING_GROUP_NOT_FOUND", "轮询组不存在，请刷新后重新分配", 409);
  if (!group.enabled) throw new AppError("ROUTING_GROUP_DISABLED", "应用绑定的轮询组已停用，请启用或重新分配", 409);
  return group;
}

/** 抽取后锁定并重新验证；上游请求失败绝不重新选路。 */
export async function selectRoutingChannel(tx: Tx, groupId: string, plugin?: PaymentChannelCode): Promise<{ channel: ChannelInstance; strategy: Group["strategy"] }> {
  const group = await loadRoutingGroup(tx, groupId);
  const selected = chooseRoutingMember(await availableMembers(tx, group, plugin), group.strategy);
  await tx.$queryRaw`SELECT id FROM channel_instances WHERE id = ${selected.channelId} FOR UPDATE`;
  const channel = await tx.channelInstance.findUniqueOrThrow({ where: { id: selected.channelId } });
  if (!channel.enabled || channel.archivedAt || channel.plugin !== selected.channel.plugin) {
    throw new AppError("ROUTING_CHANNEL_CHANGED", "选中的通道状态已变更，请重试支付请求", 409);
  }
  await assertChannelVerified(channel, tx);
  return { channel, strategy: group.strategy };
}

/** 创建应用与改派共用绑定校验，停用或无可用成员的组不能新绑定。 */
export async function requireAssignableRoutingGroup(tx: Tx, id: string) {
  const group = await loadRoutingGroup(tx, id, true);
  const available = await availableMembers(tx, group);
  if (!available.length) throw new AppError("ROUTING_GROUP_NO_CHANNEL", "轮询组没有可用通道，请检查成员启用状态与通道检测结果", 409);
  return group;
}

/** 单通道和组绑定互斥；解除绑定不恢复旧账号。 */
export async function assignRoutingGroup(applicationId: string, groupId: string | null) {
  return db.$transaction(async tx => {
    if (groupId) await requireAssignableRoutingGroup(tx, groupId);
    const application = await tx.application.findUnique({ where: { id: applicationId } });
    if (!application || application.archivedAt) throw new AppError("APPLICATION_NOT_FOUND", "应用不存在或已归档", 404);
    if (application.appId === "channel-diagnostics") throw new AppError("APPLICATION_INTERNAL", "通道验收应用不能绑定轮询组", 409);
    return tx.application.update({ where: { id: applicationId },
      data: { routingGroupId: groupId, defaultChannelId: null },
      select: { id: true, routingGroupId: true, defaultChannelId: true } });
  });
}
