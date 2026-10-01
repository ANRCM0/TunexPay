import type { IntegrationProtocol, WebhookDelivery } from "@prisma/client";
import { db } from "../db.js";
import { epaySign, openSealed, webhookSignature } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { sendWebhookRequest, type WebhookResponse } from "../lib/webhook-security.js";

export function retryDelaySeconds(attempts: number, random = Math.random()): number {
  const base = Math.min(3_600, 5 * 2 ** Math.min(Math.max(0, attempts - 1), 10));
  return Math.max(5, Math.round(base * (0.8 + random * 0.4)));
}

export async function recoverExpiredDeliveries(limit = 100): Promise<number> {
  // 先取一批再按 id 更新，而不是一条 updateMany 无条件全表更新：
  // Worker 停机很久后重启时过期租约可能上万条，一次全量更新会把「恢复后的第一跳」压得很重。
  // 批量与 listDueDeliveryIds 保持一致，积压按同样的节奏分批消化。
  const expired = await db.webhookDelivery.findMany({
    where: { status: "PROCESSING", lockedUntil: { lt: new Date() } },
    select: { id: true },
    orderBy: [{ lockedUntil: "asc" }, { id: "asc" }],
    take: limit,
  });
  if (!expired.length) return 0;
  const result = await db.webhookDelivery.updateMany({
    // 条件里重新校验一次状态与租约，避免与其它 Worker 实例抢同一批
    where: { id: { in: expired.map(item => item.id) }, status: "PROCESSING", lockedUntil: { lt: new Date() } },
    data: { status: "PENDING", lockedUntil: null, nextAttemptAt: new Date(), lastError: "上一个 Worker 租约过期，任务已自动恢复" },
  });
  return result.count;
}

export async function listDueDeliveryIds(limit = 100): Promise<Array<{ id: string; attempts: number }>> {
  return db.webhookDelivery.findMany({
    // 应用归档时该应用的通知投递已经被清掉；这里再兜一层 order.deletedAt，
    // 防止归档事务与 Worker 抢跑，让已删应用的过期通知又发出去。
    where: { status: "PENDING", nextAttemptAt: { lte: new Date() }, order: { deletedAt: null } },
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
  const url = new URL(delivery.url);
  const payload = delivery.payload as Record<string, unknown>;
  let response: WebhookResponse;
  if (delivery.protocol === ("EPAY_V1" satisfies IntegrationProtocol)) {
    const signed = { ...payload, sign_type: "MD5" };
    const sign = epaySign(signed, openSealed(delivery.application.epayKeyEncrypted));
    for (const [key, value] of Object.entries({ ...signed, sign })) url.searchParams.set(key, String(value ?? ""));
    response = await sendWebhookRequest(url.toString(), { method: "GET" });
  } else {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = webhookSignature(openSealed(delivery.application.webhookSecretEncrypted), timestamp, body);
    response = await sendWebhookRequest(url.toString(), {
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
    });
  }
  const { body } = response;
  if (response.status < 200 || response.status >= 300) throw new AppError("WEBHOOK_HTTP_ERROR", `Webhook 返回 HTTP ${response.status}: ${body.slice(0, 200)}`, 502);
  if (delivery.protocol === "EPAY_V1" && body.trim().toLowerCase() !== "success") {
    throw new AppError("WEBHOOK_ACK_INVALID", `ePay 通知未返回 success: ${body.slice(0, 200)}`, 502);
  }
  return { status: response.status, body };
}
