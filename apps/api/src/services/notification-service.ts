import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { openSealed } from "../lib/crypto.js";
import { notificationPlugin } from "../notifications/plugins.js";
import type { NotificationEventType, NotificationMessage } from "../notifications/types.js";
import { ensureLegacyNotificationMigration } from "./notification-instance-service.js";

const paymentEventTypes: NotificationEventType[] = ["ORDER_SUCCEEDED", "PAYMENT_LATE_DUPLICATE", "RECEIPT_MISMATCH", "BUSINESS_WEBHOOK_DEAD"];

function decode(payloadEncrypted: string): Record<string, unknown> {
  return JSON.parse(openSealed(payloadEncrypted)) as Record<string, unknown>;
}

async function activeInstances(tx: Prisma.TransactionClient, eventType: NotificationEventType, occurredAt?: Date) {
  return tx.notificationInstance.findMany({
    where: {
      enabled: true,
      archivedAt: null,
      ...(occurredAt ? { createdAt: { lte: occurredAt } } : {}),
      subscriptions: { some: { eventType, enabled: true, ...(occurredAt ? { createdAt: { lte: occurredAt } } : {}) } },
    },
    select: { id: true, plugin: true },
  });
}

async function enqueue(tx: Prisma.TransactionClient, instance: { id: string; plugin: string }, key: string, input: NotificationMessage) {
  await tx.ownerNotificationDelivery.upsert({
    where: { dedupeKey: `${key}:${instance.id}` },
    update: {},
    create: {
      dedupeKey: `${key}:${instance.id}`, channel: instance.plugin, instanceId: instance.id, eventType: input.event,
      title: input.title, message: input.message, payload: (input.data ?? {}) as Prisma.InputJsonValue,
    },
  });
}

async function collectPaymentEvents() {
  // Notification delivery is forward-only. Creating the first instance must not replay
  // historical payment events from before notification infrastructure was configured.
  const firstInstance = await db.notificationInstance.findFirst({ where: { archivedAt: null }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  if (!firstInstance) return;
  const events = await db.paymentEvent.findMany({
    where: { type: { in: paymentEventTypes }, createdAt: { gte: firstInstance.createdAt }, ownerSeen: { is: null } },
    include: { order: { include: { application: { select: { name: true } } } }, payment: true },
    orderBy: { id: "asc" }, take: 50,
  });
  if (!events.length) return;
  await db.$transaction(async tx => {
    for (const event of events) {
      if (await tx.ownerNotificationSeen.findUnique({ where: { eventId: event.id } })) continue;
      await tx.ownerNotificationSeen.create({ data: { eventId: event.id } });
      if (event.payment?.channel === "MOCK") continue;
      const eventType = event.type as NotificationEventType;
      const instances = await activeInstances(tx, eventType, event.createdAt);
      if (!instances.length) continue;
      const title = eventType === "ORDER_SUCCEEDED" ? "TuneXPay 收款成功" : eventType === "BUSINESS_WEBHOOK_DEAD" ? "TuneXPay 业务回调失败" : "TuneXPay 支付异常";
      const amount = ((event.payment?.receivedAmount ?? event.payment?.amount ?? event.order?.amount ?? 0) / 100).toFixed(2);
      const message = [
        `事件：${eventType}`,
        `应用：${event.order?.application.name ?? "—"}`,
        `订单：${event.order?.orderNo ?? "—"}`,
        `支付单：${event.payment?.paymentNo ?? "—"}`,
        `金额：${amount} 元`,
        `时间：${event.createdAt.toISOString()}`,
        "请登录后台核对。此提醒不替代业务回调或对账。",
      ].join("\n");
      const data = { eventId: event.id.toString(), orderNo: event.order?.orderNo, paymentNo: event.payment?.paymentNo, amountCents: event.payment?.receivedAmount ?? event.payment?.amount ?? event.order?.amount ?? 0 };
      for (const instance of instances) await enqueue(tx, instance, `event:${event.id}`, { event: eventType, title, message, data });
    }
  });
}

async function collectCollectorFailures() {
  const states = await db.billCollectorState.findMany({ where: { lastError: { not: null }, consecutiveErrors: { gte: 3 }, heartbeatAt: { gt: new Date(Date.now() - 90_000) } }, take: 100 });
  if (!states.length) return;
  const bucket = Math.floor(Date.now() / 900_000);
  await db.$transaction(async tx => {
    const instances = await activeInstances(tx, "COLLECTOR_FAILURE");
    for (const state of states) {
      const input: NotificationMessage = {
        event: "COLLECTOR_FAILURE", title: "TuneXPay 账单采集连续失败",
        message: `通道 ${state.id} 账单采集连续失败，请登录支付通道面板查看错误码与权限。每个通道每 15 分钟最多提醒一次。`,
        data: { channelId: state.id, consecutiveErrors: state.consecutiveErrors },
      };
      for (const instance of instances) await enqueue(tx, instance, `collector:${state.id}:${bucket}`, input);
    }
  });
}

async function deliverDue() {
  const now = new Date();
  await db.ownerNotificationDelivery.updateMany({ where: { status: "PROCESSING", lockedUntil: { lt: now } }, data: { status: "PENDING", leaseOwner: null, lockedUntil: null } });
  const due = await db.ownerNotificationDelivery.findMany({ where: { status: "PENDING", nextAttemptAt: { lte: now }, instanceId: { not: null } }, orderBy: { nextAttemptAt: "asc" }, take: 10 });
  for (const task of due) {
    const leaseOwner = randomUUID();
    const claimed = await db.ownerNotificationDelivery.updateMany({
      where: { id: task.id, status: "PENDING", nextAttemptAt: { lte: new Date() } },
      data: { status: "PROCESSING", leaseOwner, lockedUntil: new Date(Date.now() + 120_000), attempts: { increment: 1 } },
    });
    if (!claimed.count) continue;
    const owned = { id: task.id, status: "PROCESSING", leaseOwner };
    try {
      const instance = await db.notificationInstance.findUnique({ where: { id: task.instanceId! } });
      if (!instance || !instance.enabled || instance.archivedAt) {
        await db.ownerNotificationDelivery.updateMany({ where: owned, data: { status: "CANCELLED", lockedUntil: null, leaseOwner: null } });
        continue;
      }
      const event = (task.eventType || "TEST") as NotificationMessage["event"];
      await notificationPlugin(instance.plugin).send({ event, title: task.title, message: task.message, data: (task.payload as Record<string, unknown> | null) ?? undefined }, decode(instance.payloadEncrypted));
      await db.ownerNotificationDelivery.updateMany({ where: owned, data: { status: "SUCCESS", lockedUntil: null, leaseOwner: null, lastError: null } });
    } catch {
      const attempts = task.attempts + 1;
      await db.ownerNotificationDelivery.updateMany({
        where: owned,
        data: {
          status: attempts >= 5 ? "DEAD" : "PENDING", lockedUntil: null, leaseOwner: null,
          lastError: "SEND_FAILED_CHECK_PLUGIN_CONFIG",
          nextAttemptAt: new Date(Date.now() + Math.min(3600, 30 * 2 ** task.attempts) * 1000),
        },
      });
    }
  }
}

export async function runNotifications() {
  await ensureLegacyNotificationMigration();
  await collectPaymentEvents();
  await collectCollectorFailures();
  await deliverDue();
}
