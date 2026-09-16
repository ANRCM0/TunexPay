import { createHmac, randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import nodemailer from "nodemailer";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.js";
import { seal, openSealed } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";

const ID = "owner-default";
const fields = {
  emailEnabled: z.boolean(), feishuEnabled: z.boolean(),
  smtpHost: z.string().trim().max(253), smtpPort: z.union([z.literal(465), z.literal(587)]),
  smtpUser: z.string().trim().max(254), from: z.string().trim().max(254), to: z.string().trim().max(254),
  paymentSuccess: z.boolean(), anomalies: z.boolean(), webhookFailure: z.boolean(), collectorFailure: z.boolean(),
};
const stored = z.object({ ...fields, smtpPassword: z.string(), feishuWebhook: z.string(), feishuSecret: z.string() }).strict();
export const ownerSettingsInput = z.object({ ...fields, revision: z.number().int().positive(),
  smtpPassword: z.string().max(1000).nullable().optional(), feishuWebhook: z.string().max(500).nullable().optional(), feishuSecret: z.string().max(300).nullable().optional(),
}).strict();
export type OwnerSettings = z.infer<typeof stored>;
const defaults: OwnerSettings = { emailEnabled: false, feishuEnabled: false, smtpHost: "", smtpPort: 465, smtpUser: "", smtpPassword: "", from: "", to: "", feishuWebhook: "", feishuSecret: "", paymentSuccess: true, anomalies: true, webhookFailure: true, collectorFailure: true };
type Client = Pick<Prisma.TransactionClient, "ownerNotificationSettings">;
async function settings(client: Client = db) {
  const row = await client.ownerNotificationSettings.upsert({ where: { id: ID }, create: { id: ID, payloadEncrypted: seal(JSON.stringify(defaults)) }, update: {} });
  return { row, value: stored.parse(JSON.parse(openSealed(row.payloadEncrypted))) };
}
export function maskedOwnerSettings(value: OwnerSettings, revision: number) {
  const { smtpPassword, feishuWebhook, feishuSecret, ...rest } = value;
  return { ...rest, revision, smtpPasswordConfigured: Boolean(smtpPassword), feishuWebhookConfigured: Boolean(feishuWebhook), feishuSecretConfigured: Boolean(feishuSecret) };
}
export async function getOwnerSettings() { const { row, value } = await settings(); return maskedOwnerSettings(value, row.revision); }
export function validateFeishuWebhook(value: string) {
  if (!z.url().safeParse(value).success) throw new AppError("FEISHU_URL_INVALID", "请填写有效的飞书机器人地址", 422);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "open.feishu.cn" || url.port || url.username || url.password || url.search || url.hash || !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]{20,100}$/.test(url.pathname)) throw new AppError("FEISHU_URL_INVALID", "仅允许飞书官方自定义机器人 HTTPS Webhook", 422);
  return url;
}
export function mergeOwnerSettings(previous: OwnerSettings, raw: unknown): OwnerSettings {
  const { revision: _revision, smtpPassword, feishuWebhook, feishuSecret, ...rest } = ownerSettingsInput.parse(raw);
  const retain = (next: string | null | undefined, old: string) => next === null ? "" : next || old;
  const value = { ...rest, smtpPassword: retain(smtpPassword, previous.smtpPassword), feishuWebhook: retain(feishuWebhook === null ? null : feishuWebhook?.trim(), previous.feishuWebhook), feishuSecret: retain(feishuSecret === null ? null : feishuSecret?.trim(), previous.feishuSecret) };
  if (value.emailEnabled && (!/^[a-zA-Z0-9.-]+$/.test(value.smtpHost) || !z.email().safeParse(value.from).success || !z.email().safeParse(value.to).success || !value.smtpUser || !value.smtpPassword)) throw new AppError("EMAIL_CONFIG_INVALID", "请填写 SMTP 主机、账号、密码和有效的发件/收件邮箱", 422);
  if ((value.emailEnabled && /^replace-with/i.test(value.smtpPassword)) || (value.feishuEnabled && /^replace-with/i.test(value.feishuSecret))) throw new AppError("NOTIFICATION_PLACEHOLDER_SECRET", "请替换示例密钥后再启用", 422);
  if (value.feishuEnabled || value.feishuWebhook) validateFeishuWebhook(value.feishuWebhook);
  return value;
}
export async function saveOwnerSettings(raw: unknown) {
  const input = ownerSettingsInput.parse(raw);
  return db.$transaction(async tx => {
    await settings(tx);
    await tx.$queryRaw`SELECT id FROM owner_notification_settings WHERE id = ${ID} FOR UPDATE`;
    const { row, value } = await settings(tx);
    if (row.revision !== input.revision) throw new AppError("SETTINGS_CONFLICT", "配置已变更，请重新加载", 409);
    const next = mergeOwnerSettings(value, input);
    const updated = await tx.ownerNotificationSettings.update({ where: { id: ID }, data: { payloadEncrypted: seal(JSON.stringify(next)), revision: { increment: 1 } } });
    return maskedOwnerSettings(next, updated.revision);
  });
}
function channels(value: OwnerSettings) { return [value.emailEnabled ? "EMAIL" : null, value.feishuEnabled ? "FEISHU" : null].filter((v): v is string => Boolean(v)); }
async function enqueue(tx: Prisma.TransactionClient, value: OwnerSettings, key: string, title: string, message: string) {
  for (const channel of channels(value)) await tx.ownerNotificationDelivery.upsert({ where: { dedupeKey: `${key}:${channel}` }, update: {}, create: { dedupeKey: `${key}:${channel}`, channel, title, message } });
}
export async function testOwnerNotification(channel: "EMAIL" | "FEISHU") {
  return db.$transaction(async tx => {
    await settings(tx);
    await tx.$queryRaw`SELECT id FROM owner_notification_settings WHERE id = ${ID} FOR UPDATE`;
    const { value } = await settings(tx);
    if (!channels(value).includes(channel)) throw new AppError("NOTIFICATION_DISABLED", "请先保存并启用该渠道", 409);
    const recent = await tx.ownerNotificationDelivery.findFirst({ where: { channel, dedupeKey: { startsWith: "test:" }, createdAt: { gte: new Date(Date.now() - 60_000) } } });
    if (recent) throw new AppError("TEST_RATE_LIMIT", "每个渠道每分钟只能测试一次", 429);
    return tx.ownerNotificationDelivery.create({ data: { dedupeKey: `test:${randomUUID()}`, channel, title: "TUOXIN Pay 测试通知", message: "本人通知渠道测试。收到此消息说明发送成功。" } });
  });
}

const types = ["ORDER_SUCCEEDED", "PAYMENT_LATE_DUPLICATE", "RECEIPT_MISMATCH", "BUSINESS_WEBHOOK_DEAD"];
export function selectedOwnerEvent(type: string, value: OwnerSettings) {
  return type === "ORDER_SUCCEEDED" ? value.paymentSuccess : type === "BUSINESS_WEBHOOK_DEAD" ? value.webhookFailure : value.anomalies;
}
async function collectOwnerEvents() {
  const initial = await settings();
  const events = await db.paymentEvent.findMany({ where: { type: { in: types }, createdAt: { gte: initial.row.createdAt }, ownerSeen: { is: null } }, include: { order: { include: { application: { select: { name: true } } } }, payment: true }, orderBy: { id: "asc" }, take: 20 });
  // Seen markers and tasks commit together. No numeric cursor: an earlier event
  // may commit after a later one, so autoincrement order is not commit order.
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM owner_notification_settings WHERE id = ${ID} FOR UPDATE`;
    const { value } = await settings(tx);
    for (const event of events) {
      if (await tx.ownerNotificationSeen.findUnique({ where: { eventId: event.id } })) continue;
      await tx.ownerNotificationSeen.create({ data: { eventId: event.id } });
      if (!selectedOwnerEvent(event.type, value) || event.payment?.channel === "MOCK") continue;
      const title = event.type === "ORDER_SUCCEEDED" ? "TUOXIN Pay 收款成功" : event.type === "BUSINESS_WEBHOOK_DEAD" ? "TUOXIN Pay 业务通知失败" : "TUOXIN Pay 支付异常";
      const message = [`事件：${event.type}`, `应用：${event.order?.application.name ?? "—"}`, `订单：${event.order?.orderNo ?? "—"}`, `支付单：${event.payment?.paymentNo ?? "—"}`, `金额：${((event.payment?.receivedAmount ?? event.payment?.amount ?? event.order?.amount ?? 0) / 100).toFixed(2)} 元`, `时间：${event.createdAt.toISOString()}`, "请登录后台核对。此提醒不替代业务回调或对账。"].join("\n");
      await enqueue(tx, value, `event:${event.id}`, title, message);
    }
    const state = await tx.billCollectorState.findUnique({ where: { id: "alipay-bill-default" } });
    if (value.collectorFailure && state?.lastError && state.consecutiveErrors >= 3 && state.heartbeatAt && Date.now() - state.heartbeatAt.getTime() < 90_000) {
      await enqueue(tx, value, `collector:${Math.floor(Date.now() / 900_000)}`, "TUOXIN Pay 账单采集连续失败", "账单采集连续失败，请登录支付渠道面板查看错误码与权限。相同故障每 15 分钟最多提醒一次。");
    }
  });
}
export function feishuSignature(timestamp: string, secret: string) { return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64"); }
export function publicSmtpAddress(address: string) {
  const blocked = new BlockList();
  for (const [ip, bits] of [["0.0.0.0",8],["10.0.0.0",8],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.168.0.0",16],["100.64.0.0",10],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(ip,bits,"ipv4");
  blocked.addAddress("::", "ipv6"); blocked.addAddress("::1", "ipv6"); blocked.addSubnet("fc00::",7,"ipv6"); blocked.addSubnet("fe80::",10,"ipv6"); blocked.addSubnet("ff00::",8,"ipv6");
  return Boolean(isIP(address)) && !blocked.check(address,isIP(address) === 6 ? "ipv6" : "ipv4");
}
export async function sendOwnerNotification(channel: string, title: string, message: string, value: OwnerSettings) {
  if (channel === "EMAIL") {
    const addresses = await lookup(value.smtpHost, { all: true });
    if (!addresses.length || addresses.some(v => !publicSmtpAddress(v.address))) throw new Error("SMTP_ADDRESS_BLOCKED");
    const transport = nodemailer.createTransport({ host: addresses[0]!.address, port: value.smtpPort, secure: value.smtpPort === 465, requireTLS: true, tls: { servername: value.smtpHost, rejectUnauthorized: true }, auth: { user: value.smtpUser, pass: value.smtpPassword }, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000, disableFileAccess: true, disableUrlAccess: true });
    try { await transport.sendMail({ from: value.from, to: value.to, subject: title, text: message }); } finally { transport.close(); }
  } else {
    const url = validateFeishuWebhook(value.feishuWebhook);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json" }, body: JSON.stringify({ msg_type: "text", content: { text: `${title}\n${message}` }, ...(value.feishuSecret ? { timestamp, sign: feishuSignature(timestamp,value.feishuSecret) } : {}) }) });
    const reader = response.body?.getReader(); let text = "", size = 0;
    if (reader) { const decoder = new TextDecoder(); try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 16000) throw new Error("FEISHU_RESPONSE_TOO_LARGE"); text += decoder.decode(chunk.value, { stream: true }); } } finally { await reader.cancel(); } }
    const result = JSON.parse(text) as { code?: number; StatusCode?: number };
    if (!response.ok || (result.code ?? result.StatusCode) !== 0) throw new Error("FEISHU_SEND_FAILED");
  }
}
export async function runOwnerNotifications() {
  await collectOwnerEvents();
  const now = new Date();
  await db.ownerNotificationDelivery.updateMany({ where: { status: "PROCESSING", lockedUntil: { lt: now } }, data: { status: "PENDING", leaseOwner: null, lockedUntil: null } });
  const due = await db.ownerNotificationDelivery.findMany({ where: { status: "PENDING", nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: "asc" }, take: 5 });
  for (const task of due) {
    const owner = randomUUID();
    const claimed = await db.ownerNotificationDelivery.updateMany({ where: { id: task.id, status: "PENDING" }, data: { status: "PROCESSING", leaseOwner: owner, lockedUntil: new Date(Date.now() + 120_000), attempts: { increment: 1 } } });
    if (!claimed.count) continue;
    const owned = { id: task.id, status: "PROCESSING", leaseOwner: owner };
    try {
      const { value } = await settings();
      if (!channels(value).includes(task.channel)) { await db.ownerNotificationDelivery.updateMany({ where: owned, data: { status: "CANCELLED", lockedUntil: null, leaseOwner: null } }); continue; }
      await sendOwnerNotification(task.channel,task.title,task.message,value);
      await db.ownerNotificationDelivery.updateMany({ where: owned, data: { status: "SUCCESS", lockedUntil: null, leaseOwner: null, lastError: null } });
    } catch {
      await db.ownerNotificationDelivery.updateMany({ where: owned, data: { status: task.attempts + 1 >= 5 ? "DEAD" : "PENDING", lockedUntil: null, leaseOwner: null, lastError: "SEND_FAILED_CHECK_CHANNEL_CONFIG", nextAttemptAt: new Date(Date.now() + Math.min(3600,30 * 2 ** task.attempts) * 1000) } });
    }
  }
}
