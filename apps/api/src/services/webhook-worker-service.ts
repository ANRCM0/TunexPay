import type { IntegrationProtocol, WebhookDelivery } from "@prisma/client";
import { db } from "../db.js";
import { epaySign, openSealed, webhookSignature } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { assertSafeWebhookUrl } from "../lib/webhook-security.js";

export function retryDelaySeconds(attempts: number, random = Math.random()): number {
  const base = Math.min(3_600, 5 * 2 ** Math.min(Math.max(0, attempts - 1), 10));
  return Math.max(5, Math.round(base * (0.8 + random * 0.4)));
}

export async function recoverExpiredDeliveries(): Promise<number> {
  const result = await db.webhookDelivery.updateMany({
    where: { status: "PROCESSING", lockedUntil: { lt: new Date() } },
    data: { status: "PENDING", lockedUntil: null, nextAttemptAt: new Date(), lastError: "上一个 Worker 租约过期，任务已自动恢复" },
  });
  return result.count;
}

export async function listDueDeliveryIds(limit = 100): Promise<Array<{ id: string; attempts: number }>> {
  return db.webhookDelivery.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
    select: { id: true, attempts: true },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}

export async function deliverWebhook(id: string): Promise<void> {
  const leaseUntil = new Date(Date.now() + 30_000);
  const claimed = await db.webhookDelivery.updateMany({
    where: { id, status: "PENDING", nextAttemptAt: { lte: new Date() } },
    data: { status: "PROCESSING", lockedUntil: leaseUntil, attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return;
  const delivery = await db.webhookDelivery.findUniqueOrThrow({ where: { id }, include: { application: true, order: { select: { orderNo: true } } } });
  try {
    const response = await send(delivery);
    await db.$transaction([
      db.webhookDelivery.update({ where: { id }, data: {
        status: "SUCCESS", lockedUntil: null, deliveredAt: new Date(), responseStatus: response.status,
        responseBody: response.body.slice(0, 2_000), lastError: null,
      } }),
      db.paymentEvent.create({ data: {
        aggregateType: "ORDER", aggregateId: delivery.order.orderNo, orderId: delivery.orderId,
        type: "BUSINESS_WEBHOOK_DELIVERED", source: "WORKER", payload: { deliveryId: id, attempts: delivery.attempts, status: response.status },
      } }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dead = delivery.attempts >= delivery.maxAttempts;
    const nextAttemptAt = new Date(Date.now() + retryDelaySeconds(delivery.attempts) * 1_000);
    await db.$transaction(async (tx) => {
      await tx.webhookDelivery.update({ where: { id }, data: {
        status: dead ? "DEAD" : "PENDING", lockedUntil: null, nextAttemptAt, lastError: message.slice(0, 500),
      } });
      if (dead) await tx.paymentEvent.create({ data: {
        aggregateType: "ORDER", aggregateId: delivery.order.orderNo, orderId: delivery.orderId,
        type: "BUSINESS_WEBHOOK_DEAD", source: "WORKER", payload: { deliveryId: id, attempts: delivery.attempts, error: message.slice(0, 500) },
      } });
    });
    throw error;
  }
}

async function send(delivery: WebhookDelivery & { application: { webhookSecretEncrypted: string; epayKeyEncrypted: string }; order: { orderNo: string } }) {
  const url = await assertSafeWebhookUrl(delivery.url);
  const payload = delivery.payload as Record<string, unknown>;
  let response: Response;
  if (delivery.protocol === ("EPAY_V1" satisfies IntegrationProtocol)) {
    const signed = { ...payload, sign_type: "MD5" };
    const sign = epaySign(signed, openSealed(delivery.application.epayKeyEncrypted));
    for (const [key, value] of Object.entries({ ...signed, sign })) url.searchParams.set(key, String(value ?? ""));
    response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } else {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = webhookSignature(openSealed(delivery.application.webhookSecretEncrypted), timestamp, body);
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "TUOXIN-Pay-Webhook/0.1",
        "x-tuoxin-event": delivery.eventType.split(":")[0]!,
        "x-tuoxin-delivery": delivery.id,
        "x-tuoxin-timestamp": timestamp,
        "x-tuoxin-signature": `v1=${signature}`,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  }
  const body = await response.text();
  if (!response.ok) throw new AppError("WEBHOOK_HTTP_ERROR", `Webhook 返回 HTTP ${response.status}: ${body.slice(0, 200)}`, 502);
  if (delivery.protocol === "EPAY_V1" && body.trim().toLowerCase() !== "success") {
    throw new AppError("WEBHOOK_ACK_INVALID", `ePay 通知未返回 success: ${body.slice(0, 200)}`, 502);
  }
  return { status: response.status, body };
}
