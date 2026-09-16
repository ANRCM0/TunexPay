import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";
import { seal, sha256 } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { loadChannel } from "./channel-instance-service.js";
import { createOrder } from "./order-service.js";
import { createPayment } from "./payment-service.js";

export async function createChannelTest(id: string, revision: number) {
  const lease = randomUUID();
  const claimed = await db.channelInstance.updateMany({ where: { id, revision, enabled: true, OR: [{ checkLockedUntil: null }, { checkLockedUntil: { lte: new Date() } }] }, data: { checkLease: lease, checkLockedUntil: new Date(Date.now() + 60_000) } });
  if (!claimed.count) throw new AppError("CHANNEL_TEST_CONFLICT", "请启用并保存通道，等待当前检测完成后重试", 409);
  try {
    const row = await loadChannel(id);
    if (row.testPaymentNo && row.testRevision === revision) {
      const previous = await db.payment.findUnique({ where: { paymentNo: row.testPaymentNo }, include: { order: true } });
      if (previous && (previous.status === "SUCCESS" || (previous.status === "PROCESSING" && previous.clientPayload && previous.order.expiresAt && previous.order.expiresAt > new Date()))) {
        return { paymentNo: previous.paymentNo, cashierUrl: `${config().WEB_PUBLIC_URL}/cashier/${previous.paymentNo}` };
      }
    }
    const app = await db.application.upsert({ where: { appId: "channel-diagnostics" }, update: {}, create: {
      appId: "channel-diagnostics", name: "通道实付验收", status: "DISABLED", epayPid: "channel-diagnostics",
      apiKeyHash: sha256(randomUUID()), webhookSecretEncrypted: seal(randomUUID()), epayKeyEncrypted: seal(randomUUID()),
    } });
    const { order } = await createOrder(app, { externalOrderNo: `check-${randomUUID()}`, amount: 1, currency: "CNY", subject: `通道验收 · ${row.name}`, expiresInSeconds: 300, metadata: { channelId: id, channelRevision: revision, diagnostic: true } }, undefined);
    const payment = await createPayment({ ...app, defaultChannel: row.plugin, defaultChannelId: id }, order.orderNo, { channel: row.plugin, method: "alipay" }, `check-${order.orderNo}`);
    await db.channelInstance.updateMany({ where: { id, revision, checkLease: lease }, data: { testPaymentNo: payment.paymentNo, testRevision: revision } });
    if (payment.status === "FAILED") throw new AppError("CHANNEL_TEST_FAILED", "测试下单失败，请查看订单详情中的通道错误", 422);
    return { paymentNo: payment.paymentNo, cashierUrl: payment.cashierUrl };
  } finally {
    await db.channelInstance.updateMany({ where: { id, checkLease: lease }, data: { checkLease: null, checkLockedUntil: null } });
  }
}
