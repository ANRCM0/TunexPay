import type { Application, IntegrationProtocol, Order, Payment, Prisma, Refund } from "@prisma/client";
import { centsToYuan } from "../lib/money.js";

type Tx = Prisma.TransactionClient;

function notificationUrl(application: Application, order: Order): string | null {
  return order.notifyUrl || application.webhookUrl || null;
}

export async function createPaymentSucceededDelivery(
  tx: Tx,
  application: Application,
  order: Order,
  payment: Payment,
): Promise<void> {
  const url = notificationUrl(application, order);
  if (!url) return;
  const payload = order.protocol === "EPAY_V1"
    ? {
        pid: application.epayPid,
        trade_no: payment.paymentNo,
        out_trade_no: order.externalOrderNo,
        type: payment.method,
        name: order.subject,
        money: centsToYuan(order.amount),
        trade_status: "TRADE_SUCCESS",
        param: (order.metadata as Record<string, unknown> | null)?.param ?? "",
      }
    : {
        id: `evt_${payment.paymentNo}`,
        type: "payment.succeeded",
        createdAt: new Date().toISOString(),
        data: {
          orderNo: order.orderNo,
          externalOrderNo: order.externalOrderNo,
          paymentNo: payment.paymentNo,
          channelTradeNo: payment.channelTradeNo,
          amount: order.amount,
          currency: order.currency,
          paidAt: payment.paidAt?.toISOString(),
          metadata: order.metadata,
        },
      };
  await tx.webhookDelivery.upsert({
    where: { orderId_eventType_url: { orderId: order.id, eventType: "payment.succeeded", url } },
    create: {
      applicationId: application.id,
      orderId: order.id,
      eventType: "payment.succeeded",
      protocol: order.protocol,
      url,
      payload: payload as Prisma.InputJsonValue,
    },
    update: {},
  });
}

export async function createRefundSucceededDelivery(
  tx: Tx,
  application: Application,
  order: Order,
  payment: Payment,
  refund: Refund,
): Promise<void> {
  const url = notificationUrl(application, order);
  if (!url || order.protocol === "EPAY_V1") return;
  const eventType = `refund.succeeded:${refund.refundNo}`;
  const payload = {
    id: `evt_${refund.refundNo}`,
    type: "refund.succeeded",
    createdAt: new Date().toISOString(),
    data: {
      orderNo: order.orderNo,
      externalOrderNo: order.externalOrderNo,
      paymentNo: payment.paymentNo,
      refundNo: refund.refundNo,
      externalRefundNo: refund.externalRefundNo,
      amount: refund.amount,
      currency: order.currency,
      succeededAt: refund.succeededAt?.toISOString(),
    },
  };
  await tx.webhookDelivery.upsert({
    where: { orderId_eventType_url: { orderId: order.id, eventType, url } },
    create: {
      applicationId: application.id,
      orderId: order.id,
      eventType,
      protocol: "NATIVE_V1" satisfies IntegrationProtocol,
      url,
      payload,
    },
    update: {},
  });
}
