import type { PaymentChannelCode } from "@prisma/client";
import { db } from "../db.js";
import { generateId, randomSecret, seal, sha256 } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";

export type CreateApplicationInput = {
  name: string;
  webhookUrl?: string | null;
  defaultChannel?: PaymentChannelCode;
};

function numericPid(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(1_000_000_000 + (bytes[0]! % 9_000_000_000));
}

export async function createApplication(input: CreateApplicationInput) {
  const appId = generateId("app");
  const apiKey = `txp_${appId}_${randomSecret(24)}`;
  const webhookSecret = `whsec_${randomSecret(32)}`;
  const epayKey = randomSecret(24);
  const application = await db.application.create({
    data: {
      appId,
      name: input.name,
      webhookUrl: input.webhookUrl || null,
      defaultChannel: input.defaultChannel ?? "MOCK",
      apiKeyHash: sha256(apiKey),
      webhookSecretEncrypted: seal(webhookSecret),
      epayPid: numericPid(),
      epayKeyEncrypted: seal(epayKey),
    },
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
