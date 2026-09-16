import { createPrivateKey, createPublicKey } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { config, type Config } from "../config.js";
import { db } from "../db.js";
import { openSealed, seal } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";

const SETTINGS_ID = "alipay-bill-default";
type Client = Pick<Prisma.TransactionClient, "billChannelSettings" | "$queryRaw">;
const fields = {
  enabled: z.boolean(), collectorEnabled: z.boolean(),
  appId: z.string().trim().max(40), userId: z.string().trim().max(32),
  gateway: z.string().url().max(300), qrContent: z.string().trim().max(4000),
  matchMode: z.enum(["REMARK", "AMOUNT"]),
  validSeconds: z.number().int().min(60).max(3600),
  amountOffsetMax: z.number().int().min(0).max(99),
  pollSeconds: z.number().int().min(3).max(3600),
  lookbackSeconds: z.number().int().min(300).max(86400),
  overlapSeconds: z.number().int().min(60).max(3600),
  lagSeconds: z.number().int().min(5).max(300),
};
const storedSchema = z.object({ ...fields, privateKey: z.string(), publicKey: z.string(), watcherToken: z.string() }).strict();
export type BillSettings = z.infer<typeof storedSchema>;
export const billSettingsInputSchema = z.object({
  ...fields, revision: z.number().int().positive(),
  privateKey: z.string().max(16000).nullable().optional(),
  publicKey: z.string().max(16000).nullable().optional(),
  watcherToken: z.string().max(200).nullable().optional(),
}).strict();

function initialSettings(): BillSettings {
  const c = config();
  return {
    enabled: c.ALIPAY_BILL_ENABLED, collectorEnabled: c.ALIPAY_BILL_COLLECTOR_ENABLED,
    appId: c.ALIPAY_APP_ID, userId: c.ALIPAY_BILL_USER_ID, gateway: c.ALIPAY_GATEWAY,
    privateKey: c.ALIPAY_PRIVATE_KEY, publicKey: c.ALIPAY_PUBLIC_KEY,
    qrContent: c.ALIPAY_BILL_QR_CONTENT, watcherToken: c.ALIPAY_BILL_WATCHER_TOKEN,
    matchMode: c.ALIPAY_BILL_MATCH_MODE, validSeconds: c.ALIPAY_BILL_VALID_SECONDS,
    amountOffsetMax: c.ALIPAY_BILL_AMOUNT_OFFSET_MAX, pollSeconds: c.ALIPAY_BILL_POLL_SECONDS,
    lookbackSeconds: c.ALIPAY_BILL_LOOKBACK_SECONDS, overlapSeconds: c.ALIPAY_BILL_OVERLAP_SECONDS, lagSeconds: c.ALIPAY_BILL_LAG_SECONDS,
  };
}

export async function loadBillSettings(client: Client = db, lock = false) {
  await client.billChannelSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID, payloadEncrypted: seal(JSON.stringify(initialSettings())) }, update: {} });
  if (lock) await client.$queryRaw`SELECT id FROM bill_channel_settings WHERE id = ${SETTINGS_ID} FOR UPDATE`;
  const row = await client.billChannelSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID } });
  try {
    return { revision: row.revision, updatedAt: row.updatedAt, settings: storedSchema.parse(JSON.parse(openSealed(row.payloadEncrypted))) };
  } catch {
    throw new AppError("BILL_SETTINGS_UNREADABLE", "账单配置读取失败，请核对加密密钥，不要重置配置", 503);
  }
}

export function publicBillSettings(value: BillSettings, revision: number, updatedAt: Date) {
  const { privateKey, publicKey, watcherToken, ...publicFields } = value;
  return { ...publicFields, revision, updatedAt, privateKeyConfigured: Boolean(privateKey), publicKeyConfigured: Boolean(publicKey), watcherTokenConfigured: watcherToken.length >= 24 };
}

export async function getPublicBillSettings() {
  const row = await loadBillSettings();
  return publicBillSettings(row.settings, row.revision, row.updatedAt);
}

export function billIdentity(value: BillSettings): string {
  return JSON.stringify([value.appId, value.userId, value.gateway, value.qrContent]);
}

function keyValue(value: string | null | undefined, previous: string, kind: "PRIVATE KEY" | "PUBLIC KEY"): string {
  if (value === null) return "";
  if (!value?.trim()) return previous;
  const plain = value.trim().replace(/\\n/g, "\n");
  const pem = plain.includes("-----BEGIN") ? plain : `-----BEGIN ${kind}-----\n${plain}\n-----END ${kind}-----`;
  try {
    const key = kind === "PRIVATE KEY" ? createPrivateKey(pem) : createPublicKey(pem);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
  } catch { throw new AppError("BILL_KEY_INVALID", "请填写有效的 RSA2 密钥（至少 2048 位）", 422); }
  return pem;
}

export function mergeBillSettings(previous: BillSettings, raw: unknown): BillSettings {
  const input = billSettingsInputSchema.parse(raw);
  const { revision: _revision, privateKey, publicKey, watcherToken, ...values } = input;
  const next = {
    ...values, privateKey: keyValue(privateKey, previous.privateKey, "PRIVATE KEY"), publicKey: keyValue(publicKey, previous.publicKey, "PUBLIC KEY"),
    watcherToken: watcherToken === null ? "" : watcherToken?.trim() || previous.watcherToken,
  };
  const gateway = new URL(next.gateway);
  if (gateway.protocol !== "https:" || gateway.username || gateway.password || gateway.port || gateway.pathname !== "/gateway.do" || gateway.search || gateway.hash || !["openapi.alipay.com", "openapi.alipaydev.com", "openapi-sandbox.dl.alipaydev.com"].includes(gateway.hostname)) {
    throw new AppError("BILL_GATEWAY_INVALID", "网关仅允许支付宝官方 HTTPS 网关", 422);
  }
  if (next.collectorEnabled && (!/^\d{10,40}$/.test(next.appId) || !/^2088\d{12}$/.test(next.userId) || !next.privateKey || !next.publicKey)) {
    throw new AppError("BILL_COLLECTOR_NOT_CONFIGURED", "启用采集前请配置 App ID、2088 用户 ID 和 RSA2 密钥", 422);
  }
  if (next.collectorEnabled) {
    next.privateKey = keyValue(next.privateKey, "", "PRIVATE KEY");
    next.publicKey = keyValue(next.publicKey, "", "PUBLIC KEY");
  }
  if (next.watcherToken && next.watcherToken.length < 24) throw new AppError("BILL_TOKEN_TOO_SHORT", "外部 Watcher 令牌至少 24 字符", 422);
  if (next.enabled && (!next.qrContent || (!next.collectorEnabled && next.watcherToken.length < 24))) {
    throw new AppError("BILL_CHANNEL_NOT_CONFIGURED", "启用收款前请配置收款码及内置采集器或外部 Watcher", 422);
  }
  return next;
}

export async function saveBillSettings(raw: unknown) {
  const input = billSettingsInputSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const current = await loadBillSettings(tx, true);
    if (current.revision !== input.revision) throw new AppError("BILL_SETTINGS_CONFLICT", "配置已被修改，请重新加载后再保存", 409);
    const next = mergeBillSettings(current.settings, input);
    if (billIdentity(next) !== billIdentity(current.settings)) {
      const history = await tx.payment.count({ where: { channel: "ALIPAY_BILL" } });
      const collector = await tx.billCollectorState.findUnique({ where: { id: SETTINGS_ID } });
      if (history || collector) throw new AppError("BILL_ACCOUNT_CHANGE_BLOCKED", "已有账单支付记录或采集断点，不能直接更换账号、网关或收款码；请先做账号迁移", 409);
    }
    const row = await tx.billChannelSettings.update({ where: { id: SETTINGS_ID }, data: { payloadEncrypted: seal(JSON.stringify(next)), revision: { increment: 1 } } });
    // Configuration changes should wake the collector even if a previous failure
    // put it into a long retry backoff; in-flight pages use their old snapshot.
    await tx.billCollectorState.updateMany({ where: { id: SETTINGS_ID }, data: { nextRunAt: new Date() } });
    return publicBillSettings(next, row.revision, row.updatedAt);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function billRuntimeConfig(client: Client = db, lock = false): Promise<Config & { billRevision: number }> {
  const { settings: s, revision } = await loadBillSettings(client, lock);
  return { ...config(), billRevision: revision,
    ALIPAY_APP_ID: s.appId, ALIPAY_PRIVATE_KEY: s.privateKey, ALIPAY_PUBLIC_KEY: s.publicKey, ALIPAY_GATEWAY: s.gateway,
    ALIPAY_BILL_ENABLED: s.enabled, ALIPAY_BILL_COLLECTOR_ENABLED: s.collectorEnabled, ALIPAY_BILL_USER_ID: s.userId,
    ALIPAY_BILL_QR_CONTENT: s.qrContent, ALIPAY_BILL_MATCH_MODE: s.matchMode, ALIPAY_BILL_VALID_SECONDS: s.validSeconds,
    ALIPAY_BILL_AMOUNT_OFFSET_MAX: s.amountOffsetMax, ALIPAY_BILL_WATCHER_TOKEN: s.watcherToken,
    ALIPAY_BILL_POLL_SECONDS: s.pollSeconds, ALIPAY_BILL_LOOKBACK_SECONDS: s.lookbackSeconds, ALIPAY_BILL_OVERLAP_SECONDS: s.overlapSeconds, ALIPAY_BILL_LAG_SECONDS: s.lagSeconds,
  };
}
