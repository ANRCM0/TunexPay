import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db.js";
import { openSealed, seal } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { notificationPlugin, notificationPluginCatalog } from "../notifications/plugins.js";
import { NOTIFICATION_EVENTS, type NotificationEventType } from "../notifications/types.js";

const idSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{2,59}$/);
const inputSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(120),
  plugin: z.string().trim().min(1).max(32),
  enabled: z.boolean().default(false),
  revision: z.number().int().positive().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).optional(),
}).strict();

function generatedId(plugin: string) {
  return `notify-${plugin.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${randomUUID().slice(0, 8)}`.slice(0, 60);
}

function decode(payloadEncrypted: string): Record<string, unknown> {
  const value = JSON.parse(openSealed(payloadEncrypted));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_NOTIFICATION_CONFIG");
  return value as Record<string, unknown>;
}

function view(row: { id: string; plugin: string; name: string; enabled: boolean; revision: number; payloadEncrypted: string; archivedAt: Date | null; createdAt: Date; updatedAt: Date; subscriptions?: Array<{ eventType: string; enabled: boolean }> }) {
  const plugin = notificationPlugin(row.plugin);
  return {
    id: row.id, plugin: row.plugin, name: row.name, enabled: row.enabled, revision: row.revision,
    config: plugin.publicConfig(decode(row.payloadEncrypted)),
    events: (row.subscriptions ?? []).filter(item => item.enabled).map(item => item.eventType),
    archivedAt: row.archivedAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

function legacyEvents(value: Record<string, unknown>): NotificationEventType[] {
  const result: NotificationEventType[] = [];
  if (value.paymentSuccess !== false) result.push("ORDER_SUCCEEDED");
  if (value.anomalies !== false) result.push("PAYMENT_LATE_DUPLICATE", "RECEIPT_MISMATCH");
  if (value.webhookFailure !== false) result.push("BUSINESS_WEBHOOK_DEAD");
  if (value.collectorFailure !== false) result.push("COLLECTOR_FAILURE");
  return result;
}

export async function ensureLegacyNotificationMigration(): Promise<void> {
  const existing = await db.notificationInstance.count();
  if (existing) return;
  const legacy = await db.ownerNotificationSettings.findUnique({ where: { id: "owner-default" } });
  if (!legacy) return;
  let value: Record<string, unknown>;
  try { value = JSON.parse(openSealed(legacy.payloadEncrypted)) as Record<string, unknown>; } catch { return; }
  const events = legacyEvents(value);
  const candidates: Array<{ id: string; plugin: string; name: string; enabled: boolean; config: Record<string, unknown> }> = [];
  if (value.smtpHost || value.smtpUser || value.smtpPassword || value.from || value.to) candidates.push({
    id: "legacy-email", plugin: "SMTP", name: "原邮箱通知", enabled: value.emailEnabled === true,
    config: { host: value.smtpHost ?? "", port: value.smtpPort ?? 465, user: value.smtpUser ?? "", password: value.smtpPassword ?? "", from: value.from ?? "", to: value.to ?? "" },
  });
  if (value.feishuWebhook) candidates.push({
    id: "legacy-feishu", plugin: "FEISHU_BOT", name: "原飞书机器人", enabled: value.feishuEnabled === true,
    config: { webhook: value.feishuWebhook ?? "", secret: value.feishuSecret ?? "" },
  });
  if (!candidates.length) return;
  await db.$transaction(async tx => {
    if (await tx.notificationInstance.count()) return;
    for (const candidate of candidates) {
      let normalized: Record<string, unknown>;
      try { normalized = notificationPlugin(candidate.plugin).normalizeConfig(candidate.config); } catch { continue; }
      await tx.notificationInstance.create({
        data: {
          id: candidate.id, plugin: candidate.plugin, name: candidate.name, enabled: candidate.enabled, payloadEncrypted: seal(JSON.stringify(normalized)),
          subscriptions: { create: events.map(eventType => ({ eventType, enabled: true })) },
        },
      });
      const legacyChannel = candidate.plugin === "SMTP" ? "EMAIL" : candidate.plugin === "FEISHU_BOT" ? "FEISHU" : null;
      if (legacyChannel) {
        await tx.ownerNotificationDelivery.updateMany({
          where: { instanceId: null, channel: legacyChannel, status: { in: ["PENDING", "PROCESSING"] } },
          data: { instanceId: candidate.id, channel: candidate.plugin, status: "PENDING", lockedUntil: null, leaseOwner: null },
        });
      }
    }
  });
}

export async function listNotificationPlugins() { return notificationPluginCatalog(); }

export async function listNotificationInstances(includeArchived = false) {
  await ensureLegacyNotificationMigration();
  const rows = await db.notificationInstance.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    include: { subscriptions: true },
    orderBy: [{ archivedAt: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(view);
}

export async function getNotificationInstance(id: string) {
  await ensureLegacyNotificationMigration();
  const row = await db.notificationInstance.findUnique({ where: { id }, include: { subscriptions: true } });
  if (!row) throw new AppError("NOTIFICATION_INSTANCE_NOT_FOUND", "通知实例不存在", 404);
  return view(row);
}

export async function createNotificationInstance(raw: unknown) {
  await ensureLegacyNotificationMigration();
  const input = inputSchema.parse(raw);
  const plugin = notificationPlugin(input.plugin);
  const normalized = plugin.normalizeConfig(input.config);
  const id = input.id ?? generatedId(input.plugin);
  const events = input.events ?? [...NOTIFICATION_EVENTS];
  const row = await db.notificationInstance.create({
    data: {
      id, plugin: input.plugin, name: input.name, enabled: input.enabled, payloadEncrypted: seal(JSON.stringify(normalized)),
      subscriptions: { create: [...new Set(events)].map(eventType => ({ eventType, enabled: true })) },
    },
    include: { subscriptions: true },
  });
  return view(row);
}

export async function saveNotificationInstance(id: string, raw: unknown) {
  const input = inputSchema.omit({ id: true }).parse(raw);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM notification_instances WHERE id = ${id} FOR UPDATE`;
    const current = await tx.notificationInstance.findUnique({ where: { id }, include: { subscriptions: true } });
    if (!current || current.archivedAt) throw new AppError("NOTIFICATION_INSTANCE_NOT_FOUND", "通知实例不存在", 404);
    if (!input.revision || input.revision !== current.revision) throw new AppError("NOTIFICATION_CONFIG_CONFLICT", "通知配置已变更，请重新加载", 409);
    if (input.plugin !== current.plugin) throw new AppError("NOTIFICATION_PLUGIN_IMMUTABLE", "通知实例创建后不能更换插件", 409);
    const normalized = notificationPlugin(current.plugin).normalizeConfig(input.config, decode(current.payloadEncrypted));
    if (input.events !== undefined) {
      const selected = new Set(input.events);
      for (const eventType of NOTIFICATION_EVENTS) {
        await tx.notificationSubscription.upsert({
          where: { instanceId_eventType: { instanceId: id, eventType } },
          create: { instanceId: id, eventType, enabled: selected.has(eventType) },
          update: { enabled: selected.has(eventType) },
        });
      }
    }
    const row = await tx.notificationInstance.update({
      where: { id }, data: { name: input.name, enabled: input.enabled, payloadEncrypted: seal(JSON.stringify(normalized)), revision: { increment: 1 } },
      include: { subscriptions: true },
    });
    return view(row);
  });
}

export async function setNotificationSubscriptions(id: string, rawEvents: unknown) {
  const events = z.array(z.enum(NOTIFICATION_EVENTS)).parse(rawEvents);
  const selected = new Set(events);
  await db.$transaction(async tx => {
    const row = await tx.notificationInstance.findUnique({ where: { id } });
    if (!row || row.archivedAt) throw new AppError("NOTIFICATION_INSTANCE_NOT_FOUND", "通知实例不存在", 404);
    for (const eventType of NOTIFICATION_EVENTS) {
      await tx.notificationSubscription.upsert({
        where: { instanceId_eventType: { instanceId: id, eventType } },
        create: { instanceId: id, eventType, enabled: selected.has(eventType) },
        update: { enabled: selected.has(eventType) },
      });
    }
  });
  return getNotificationInstance(id);
}

export async function deleteNotificationInstance(id: string) {
  const row = await db.notificationInstance.findUnique({ where: { id }, select: { id: true, name: true, _count: { select: { deliveries: true } } } });
  if (!row) throw new AppError("NOTIFICATION_INSTANCE_NOT_FOUND", "通知实例不存在", 404);
  if (!row._count.deliveries) {
    await db.notificationInstance.delete({ where: { id } });
    return { id, name: row.name, archived: false as const };
  }
  await db.$transaction([
    db.notificationInstance.update({ where: { id }, data: { enabled: false, archivedAt: new Date(), revision: { increment: 1 } } }),
    db.ownerNotificationDelivery.updateMany({ where: { instanceId: id, status: { in: ["PENDING", "PROCESSING"] } }, data: { status: "CANCELLED", lockedUntil: null, leaseOwner: null } }),
  ]);
  return { id, name: row.name, archived: true as const };
}

export async function setNotificationInstanceEnabled(id: string, enabled: boolean) {
  const row = await db.notificationInstance.findUnique({ where: { id } });
  if (!row || row.archivedAt) throw new AppError("NOTIFICATION_INSTANCE_NOT_FOUND", "通知实例不存在", 404);
  return db.notificationInstance.update({ where: { id }, data: { enabled, revision: { increment: 1 } } });
}

export async function testNotificationInstance(id: string) {
  const row = await db.notificationInstance.findUnique({ where: { id } });
  if (!row || row.archivedAt) throw new AppError("NOTIFICATION_INSTANCE_NOT_FOUND", "通知实例不存在", 404);
  if (!row.enabled) throw new AppError("NOTIFICATION_DISABLED", "请先启用并保存通知实例", 409);
  const recent = await db.ownerNotificationDelivery.findFirst({ where: { instanceId: id, eventType: "TEST", createdAt: { gte: new Date(Date.now() - 60_000) } } });
  if (recent) throw new AppError("TEST_RATE_LIMIT", "每个通知实例每分钟只能测试一次", 429);
  return db.ownerNotificationDelivery.create({
    data: {
      dedupeKey: `test:${id}:${randomUUID()}`, channel: row.plugin, instanceId: id, eventType: "TEST",
      title: "TuneXPay 测试通知", message: "通知插件测试。收到此消息说明该实例发送成功。", payload: { test: true },
    },
  });
}

export async function listNotificationDeliveries() {
  return db.ownerNotificationDelivery.findMany({
    orderBy: { createdAt: "desc" }, take: 50,
    include: { instance: { select: { name: true, plugin: true } } },
  });
}

export async function retryNotificationDelivery(id: string) {
  const row = await db.ownerNotificationDelivery.findUnique({ where: { id } });
  if (!row) throw new AppError("NOTIFICATION_DELIVERY_NOT_FOUND", "通知投递不存在", 404);
  if (!row.instanceId) throw new AppError("NOTIFICATION_LEGACY_DELIVERY", "旧版通知记录没有实例绑定，不能自动重试", 409);
  return db.ownerNotificationDelivery.update({ where: { id }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lockedUntil: null, leaseOwner: null, lastError: null } });
}
