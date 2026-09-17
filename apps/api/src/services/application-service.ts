import type { ApplicationStatus, PaymentChannelCode } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { generateId, randomSecret, seal, sha256 } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { loadChannel, assertChannelVerified } from "./channel-instance-service.js";

// 通道实付验收用的内部应用由 channel-test-service 自动创建，不出现在应用列表里，也不允许从管理端启停或删除。
export const INTERNAL_APPLICATION_ID = "channel-diagnostics";

export type ApplicationCredentials = { apiKey: string; webhookSecret: string; epayKey: string };

export type CreateApplicationInput = {
  name: string;
  webhookUrl?: string | null;
  defaultChannel?: PaymentChannelCode;
  defaultChannelId?: string;
};

function numericPid(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(1_000_000_000 + (bytes[0]! % 9_000_000_000));
}

export async function createApplication(input: CreateApplicationInput) {
  const channel = input.defaultChannelId ? await loadChannel(input.defaultChannelId) : null;
  if (channel) await assertChannelVerified(channel);
  const appId = generateId("app");
  const apiKey = `txp_${appId}_${randomSecret(24)}`;
  const webhookSecret = `whsec_${randomSecret(32)}`;
  const epayKey = randomSecret(24);
  const application = await db.$transaction(async tx => {
    if (channel) {
      await tx.$queryRaw`SELECT id FROM channel_instances WHERE id = ${channel.id} FOR UPDATE`;
      const current = await tx.channelInstance.findUniqueOrThrow({ where: { id: channel.id } });
      if (!current.enabled || current.revision !== channel.revision) throw new AppError("CHANNEL_CONFIG_CONFLICT", "通道配置已变更，请重新加载", 409);
      await assertChannelVerified(current, tx);
    }
    return tx.application.create({
    data: {
      appId,
      name: input.name,
      webhookUrl: input.webhookUrl || null,
      defaultChannel: channel?.plugin ?? input.defaultChannel ?? "MOCK",
      defaultChannelId: channel?.id,
      apiKeyHash: sha256(apiKey),
      webhookSecretEncrypted: seal(webhookSecret),
      epayPid: numericPid(),
      epayKeyEncrypted: seal(epayKey),
    },
    });
  });
  return { application, credentials: { apiKey, webhookSecret, epayPid: application.epayPid, epayKey } };
}

export async function rotateApplicationApiKey(id: string) {
  const application = await db.application.findUnique({ where: { id } });
  if (!application) throw new AppError("APPLICATION_NOT_FOUND", "应用不存在", 404);
  const apiKey = `txp_${application.appId}_${randomSecret(24)}`;
  await db.application.update({ where: { id }, data: { apiKeyHash: sha256(apiKey) } });
  return { apiKey };
}

// 重置该应用的全部凭据：接口鉴权 Key、回调验签密钥、ePay 商户密钥。
// epayPid 保持不换：它是商户标识而不是密钥，轮换只会让对端已配置的商户号失效，安全收益为零。
export async function rotateApplicationCredentials(id: string): Promise<ApplicationCredentials> {
  const application = await db.application.findUnique({ where: { id } });
  if (!application) throw new AppError("APPLICATION_NOT_FOUND", "应用不存在", 404);
  const apiKey = `txp_${application.appId}_${randomSecret(24)}`;
  const webhookSecret = `whsec_${randomSecret(32)}`;
  const epayKey = randomSecret(24);
  await db.application.update({
    where: { id },
    data: { apiKeyHash: sha256(apiKey), webhookSecretEncrypted: seal(webhookSecret), epayKeyEncrypted: seal(epayKey) },
  });
  return { apiKey, webhookSecret, epayKey };
}

export async function updateApplicationStatus(id: string, status: ApplicationStatus) {
  const application = await db.application.findUnique({ where: { id } });
  if (!application) throw new AppError("APPLICATION_NOT_FOUND", "应用不存在", 404);
  if (application.appId === INTERNAL_APPLICATION_ID) throw new AppError("APPLICATION_INTERNAL", "通道验收用的内部应用不参与启停", 409);
  if (application.status === status) return application;
  return db.application.update({ where: { id }, data: { status } });
}

// 删除前置校验：订单、退款、通知投递都是资金事实或待投递事实，任何一条存在都不允许随应用消失。
export async function deleteApplication(id: string) {
  const application = await db.application.findUnique({
    where: { id },
    select: { appId: true, name: true, _count: { select: { orders: true, refunds: true, webhookDeliveries: true } } },
  });
  if (!application) throw new AppError("APPLICATION_NOT_FOUND", "应用不存在", 404);
  if (application.appId === INTERNAL_APPLICATION_ID) throw new AppError("APPLICATION_INTERNAL", "通道验收用的内部应用不允许删除", 409);
  assertNoBusinessData(application._count);
  try {
    await db.application.delete({ where: { id } });
  } catch (error) {
    // 计数与删除之间若并发落进一笔新订单，外键会拦住删除；这里转成同一条可读结论。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") assertNoBusinessData({ orders: 1, refunds: 0, webhookDeliveries: 0 });
    throw error;
  }
  return { appId: application.appId, name: application.name };
}

function assertNoBusinessData(count: { orders: number; refunds: number; webhookDeliveries: number }): void {
  if (!count.orders && !count.refunds && !count.webhookDeliveries) return;
  throw new AppError(
    "APPLICATION_HAS_BUSINESS_DATA",
    `该应用已产生业务数据（订单 ${count.orders} 笔、退款 ${count.refunds} 笔、通知投递 ${count.webhookDeliveries} 条）。订单与流水是资金事实，不能随应用删除；请改用停用。`,
    409,
  );
}
