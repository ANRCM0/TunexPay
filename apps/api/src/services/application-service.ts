import type { PaymentChannelCode } from "@prisma/client";
import { db } from "../db.js";
import { generateId, randomSecret, seal, sha256 } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { loadChannel, assertChannelVerified } from "./channel-instance-service.js";

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
