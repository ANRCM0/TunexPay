import { Prisma, type Application, type Payment, type PaymentStatus } from "@prisma/client";
import { z } from "zod";
import { adapterForPayment, assertChannelVerified } from "./channel-instance-service.js";
import type { ChannelWebhookResult } from "../channels/types.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { generateId } from "../lib/crypto.js";
import { AppError, ChannelDefinitiveError, ChannelUncertainError, errorMessage } from "../lib/errors.js";
import { RECOVERY_MAX_ATTEMPTS, initialRecoveryAt, isRecoverablePayment, recoveryAt } from "../lib/recovery-policy.js";
import { assertPaymentTransition, canPaymentTransition } from "../lib/state-machine.js";
import { createPaymentSucceededDelivery } from "./outbox-service.js";
import { openLateDuplicateException } from "./payment-exception-service.js";
import { prepareReceiptPayment } from "./receipt-reservation-service.js";
import { selectRoutingChannel } from "./routing-group-service.js";
import { billRuntimeConfig } from "./bill-settings-service.js";
import { cashierAccess, safeReturnUrl } from "../lib/cashier-security.js";
import { publishPaymentChange } from "../lib/payment-wake.js";

export const createPaymentSchema = z.object({
  channel: z.enum(["ALIPAY", "ALIPAY_BILL", "MOCK"]).optional(),
  method: z.string().trim().min(1).max(32).default("alipay"),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export async function createPayment(application: Application, orderNo: string, input: CreatePaymentInput, idempotencyKey?: string) {
  const key = idempotencyKey?.trim() || null;
  if (key && key.length > 120) throw new AppError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 不能超过 120 个字符");
  const routingGroupId = application.routingGroupId || null;
  const requestedChannel = input.channel ?? application.defaultChannel;
  const unassigned = !routingGroupId && !application.defaultChannelId;
  if (unassigned && !key) throw new AppError("CHANNEL_NOT_ASSIGNED", "应用尚未绑定轮询组或收款通道，请先在后台分配", 409);
  if (!routingGroupId && input.channel && requestedChannel !== application.defaultChannel && !key) {
    throw new AppError("CHANNEL_NOT_ASSIGNED", "请使用应用已分配的通道", 403);
  }
  // 先锁订单，再选路：同一订单的幂等检查和 attemptNo 分配串行进行。
  // READ COMMITTED 下，取得行锁后的普通 SELECT 读取最新提交值，不会命中旧快照；
  // 避免 Serializable 将所有候选通道加共享读锁后，随机选择的排他锁升级发生死锁。
  const dispatch = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM orders WHERE orderNo = ${orderNo} FOR UPDATE`;
    const order = await tx.order.findFirst({ where: { orderNo, applicationId: application.id, deletedAt: null } });
    if (!order) throw new AppError("ORDER_NOT_FOUND", "订单不存在", 404);
    if (key) {
      const existing = await tx.payment.findUnique({ where: { orderId_idempotencyKey: { orderId: order.id, idempotencyKey: key } } });
      // 幂等重试不会重新选路：不受组停用、成员移除、应用改派或订单成功/过期影响。
      if (existing) return { payment: existing, shouldDispatch: false };
    }
    if (order.expiresAt && order.expiresAt <= new Date()) throw new AppError("ORDER_EXPIRED", "订单已过期", 409);
    if (!["CREATED", "PENDING"].includes(order.status)) throw new AppError("ORDER_NOT_PAYABLE", `订单状态 ${order.status} 不允许发起支付`, 409);
    if (unassigned) throw new AppError("CHANNEL_NOT_ASSIGNED", "应用尚未绑定轮询组或收款通道，请先在后台分配", 409);
    let routingStrategy: string | null = null;
    let instance;
    if (routingGroupId) {
      const selection = await selectRoutingChannel(tx, routingGroupId, input.channel);
      instance = selection.channel;
      routingStrategy = selection.strategy;
    } else {
      if (requestedChannel !== application.defaultChannel) throw new AppError("CHANNEL_NOT_ASSIGNED", "请使用应用已分配的通道", 403);
      const assignedId = application.defaultChannelId!;
      await tx.$queryRaw`SELECT id FROM channel_instances WHERE id = ${assignedId} FOR UPDATE`;
      instance = await tx.channelInstance.findUniqueOrThrow({ where: { id: assignedId } });
      if (instance.archivedAt) throw new AppError("CHANNEL_ARCHIVED", "该通道已删除，不能再发起新支付，请为应用重新分配通道", 409);
      if (!instance.enabled || instance.plugin !== requestedChannel) throw new AppError("CHANNEL_DISABLED", "所选通道未启用或插件不匹配", 409);
      if (application.appId !== "channel-diagnostics") await assertChannelVerified(instance, tx);
    }
    const channel = instance.plugin;
    const channelId = instance.id;
    if (channel === "ALIPAY_BILL") await billRuntimeConfig(tx, true, channelId);
    const count = await tx.payment.count({ where: { orderId: order.id } });
    const created = await tx.payment.create({
      data: {
        paymentNo: generateId("pay"),
        orderId: order.id,
        attemptNo: count + 1,
        idempotencyKey: key,
        channel,
        channelId,
        routingGroupId,
        method: input.method,
        amount: order.amount,
        channelAmount: order.amount,
      },
    });
    const prepared = await prepareReceiptPayment(tx, created, order.expiresAt);
    await tx.order.update({ where: { id: order.id }, data: { status: "PENDING" } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "PAYMENT", aggregateId: prepared.paymentNo, orderId: order.id, paymentId: prepared.id,
      type: "PAYMENT_CREATED", source: "API", payload: {
        channel, channelId, routingGroupId, routingStrategy, attemptNo: prepared.attemptNo, channelAmount: prepared.channelAmount,
        receiptMatchMode: prepared.receiptMatchMode, receiptMatchReference: prepared.receiptMatchReference,
      },
    } });
    const processing = await tx.payment.update({ where: { id: prepared.id }, data: {
      status: "PROCESSING", nextQueryAt: channel === "ALIPAY" ? initialRecoveryAt() : null,
    } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "PAYMENT", aggregateId: created.paymentNo, orderId: order.id, paymentId: created.id,
      type: "CHANNEL_CREATE_REQUESTED", source: "API", payload: { channel, channelId, routingGroupId, routingStrategy },
    } });
    return { payment: processing, shouldDispatch: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  const payment = dispatch.payment;
  if (!dispatch.shouldDispatch) return presentPayment(payment);
  const order = await db.order.findUniqueOrThrow({ where: { id: payment.orderId } });
  try {
    const result = await (await adapterForPayment(payment)).create({
      paymentNo: payment.paymentNo,
      amount: payment.channelAmount,
      businessAmount: payment.amount,
      subject: order.subject,
      description: order.description,
      notifyUrl: `${config().API_PUBLIC_URL}/api/v1/channels/${payment.channel.toLowerCase()}/webhook`,
      matchReference: payment.receiptMatchMode === "REMARK" ? payment.receiptMatchReference : null,
      validUntil: payment.receiptValidUntil,
    });
    const updated = await updatePaymentObservation(payment, result.status, {
      channelOrderNo: result.channelOrderNo,
      channelTradeNo: result.channelTradeNo,
      clientPayload: result.clientPayload,
      rawResponse: result.raw as Prisma.InputJsonValue,
    });
    return presentPayment(updated);
  } catch (error) {
    const status: PaymentStatus = error instanceof ChannelUncertainError ? "UNKNOWN" : "FAILED";
    const updated = await updatePaymentObservation(payment, status, {
      errorCode: error instanceof ChannelDefinitiveError ? error.code : status === "UNKNOWN" ? "CHANNEL_RESULT_UNKNOWN" : "CHANNEL_ERROR",
      errorMessage: errorMessage(error).slice(0, 500),
    });
    return presentPayment(updated);
  }
}

async function updatePaymentObservation(payment: Payment, status: PaymentStatus, data: Record<string, unknown>, source = "CHANNEL"): Promise<Payment> {
  const observed = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${payment.id} FOR UPDATE`;
    const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    if (current.status === "SUCCESS" || !canPaymentTransition(current.status, status)) return current;
    const updated = await tx.payment.update({ where: { id: payment.id }, data: {
      status,
      ...data,
      nextQueryAt: payment.channel === "ALIPAY" && isRecoverablePayment(status) ? recoveryAt(Math.max(1, payment.queryAttempts)) : null,
    } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "PAYMENT", aggregateId: payment.paymentNo, orderId: payment.orderId, paymentId: payment.id,
      type: `PAYMENT_${status}`, source, payload: {
        errorCode: typeof data.errorCode === "string" ? data.errorCode : null,
        errorMessage: typeof data.errorMessage === "string" ? data.errorMessage : null,
      },
    } });
    return updated;
  });
  // 状态没推进就不打扰收银台的长轮询；提交之后再发布，避免等待者醒来查到旧值。
  if (observed.status !== payment.status) publishPaymentChange(observed.paymentNo);
  return observed;
}

export async function markPaymentSucceeded(result: ChannelWebhookResult, source: string): Promise<Payment> {
  // 保留 Serializable：晚到重复支付的判定依赖「锁住订单行之后再重读订单状态」。在 Serializable 下
  // 这次重读是加锁读，一定看到最新已提交值；否则可能读到本事务开始时的旧快照，把一笔重复支付
  // 误判成首次成功并改写胜出支付单。
  const succeeded = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE paymentNo = ${result.paymentNo} FOR UPDATE`;
    const current = await tx.payment.findUnique({ where: { paymentNo: result.paymentNo } });
    if (!current) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
    if (current.amount !== result.amount) throw new AppError("PAYMENT_AMOUNT_MISMATCH", "通道回调金额与支付单金额不一致", 409, { expected: current.amount, actual: result.amount });
    if (current.status === "SUCCESS") {
      if (current.channelTradeNo && result.channelTradeNo && current.channelTradeNo !== result.channelTradeNo) {
        throw new AppError("PAYMENT_TRADE_CONFLICT", "成功支付单对应了不同的通道交易号", 409, {
          expected: current.channelTradeNo,
          actual: result.channelTradeNo,
        });
      }
      if (current.receivedAmount && result.receivedAmount && current.receivedAmount !== result.receivedAmount) {
        throw new AppError("PAYMENT_RECEIVED_AMOUNT_CONFLICT", "成功支付单对应了不同的实收金额", 409, {
          expected: current.receivedAmount,
          actual: result.receivedAmount,
        });
      }
      return current;
    }
    assertPaymentTransition(current.status, "SUCCESS");
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${current.orderId} FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: current.orderId }, include: { application: true } });
    const paidAt = result.paidAt ?? new Date();
    const payment = await tx.payment.update({ where: { id: current.id }, data: {
      status: "SUCCESS",
      channelTradeNo: result.channelTradeNo,
      receivedAmount: result.receivedAmount ?? result.amount,
      paidAt,
      errorCode: null,
      errorMessage: null,
      rawResponse: result.raw,
      nextQueryAt: null,
    } });
    const isLateDuplicate = order.status === "SUCCESS" || order.status === "PARTIALLY_REFUNDED" || order.status === "REFUNDED";
    await tx.paymentEvent.create({ data: {
      aggregateType: "PAYMENT", aggregateId: payment.paymentNo, orderId: order.id, paymentId: payment.id,
      type: isLateDuplicate ? "PAYMENT_LATE_DUPLICATE" : "PAYMENT_SUCCEEDED", source,
      payload: { previousStatus: current.status, channelTradeNo: result.channelTradeNo, paidAt: paidAt.toISOString() },
    } });
    if (isLateDuplicate) {
      await openLateDuplicateException(tx, {
        orderId: order.id,
        orderNo: order.orderNo,
        winningPaymentId: order.winningPaymentId,
        paymentId: payment.id,
        paymentNo: payment.paymentNo,
        amount: payment.amount,
        receivedAmount: payment.receivedAmount ?? payment.amount,
        channelTradeNo: payment.channelTradeNo ?? undefined,
        source,
      });
      return payment;
    }
    const updatedOrder = await tx.order.update({ where: { id: order.id }, data: {
      status: "SUCCESS", paidAt, winningPaymentId: payment.id,
      expirationNextAttemptAt: null, expirationLockedUntil: null, expirationError: null,
    } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "ORDER", aggregateId: order.orderNo, orderId: order.id, paymentId: payment.id,
      type: "ORDER_SUCCEEDED", source, payload: { paymentNo: payment.paymentNo },
    } });
    await createPaymentSucceededDelivery(tx, order.application, updatedOrder, payment);
    return payment;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  // 提交之后再唤醒收银台长轮询：等待者醒来重查时一定读到 SUCCESS。
  publishPaymentChange(succeeded.paymentNo);
  return succeeded;
}

export async function queryPayment(applicationId: string | null, paymentNo: string) {
  const payment = await db.payment.findFirst({ where: { paymentNo, ...(applicationId ? { order: { applicationId, deletedAt: null } } : {}) }, include: { order: true } });
  if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
  const result = await (await adapterForPayment(payment)).query(payment.paymentNo);
  if (result.status === "SUCCESS") {
    if (!Number.isSafeInteger(result.amount) || result.amount <= 0) {
      throw new AppError("PAYMENT_QUERY_AMOUNT_INVALID", "通道成功查单缺少有效的整数金额", 502);
    }
    const succeeded = await markPaymentSucceeded({
      eventKey: `query:${payment.paymentNo}:${result.channelTradeNo ?? "success"}`,
      paymentNo: payment.paymentNo,
      status: "SUCCESS",
      amount: result.amount,
      channelTradeNo: result.channelTradeNo,
      paidAt: result.paidAt,
      raw: result.raw as Prisma.InputJsonValue,
    }, "QUERY");
    return presentPayment(succeeded);
  }
  if (payment.status !== result.status && payment.status !== "SUCCESS" && canPaymentTransition(payment.status, result.status)) {
    return presentPayment(await updatePaymentObservation(payment, result.status, { rawResponse: result.raw as Prisma.InputJsonValue }, "QUERY"));
  }
  if (payment.channel === "ALIPAY" && isRecoverablePayment(payment.status) && !payment.nextQueryAt && payment.queryAttempts < RECOVERY_MAX_ATTEMPTS) {
    await db.payment.updateMany({
      where: { id: payment.id, status: payment.status, nextQueryAt: null, queryAttempts: payment.queryAttempts },
      data: { nextQueryAt: initialRecoveryAt() },
    });
    return presentPayment(await db.payment.findUniqueOrThrow({ where: { id: payment.id } }));
  }
  return presentPayment(payment);
}

export async function getPayment(applicationId: string, paymentNo: string) {
  const payment = await db.payment.findFirst({ where: { paymentNo, order: { applicationId, deletedAt: null } } });
  if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
  return presentPayment(payment);
}

export async function closePayment(applicationId: string | null, paymentNo: string, source = "API") {
  const payment = await db.payment.findFirst({ where: { paymentNo, ...(applicationId ? { order: { applicationId, deletedAt: null } } : {}) } });
  if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
  if (payment.status === "SUCCESS" || payment.status === "CLOSED") return presentPayment(payment);
  if (!["CREATED", "PROCESSING", "UNKNOWN"].includes(payment.status)) throw new AppError("PAYMENT_NOT_CLOSABLE", `支付状态 ${payment.status} 不允许关闭`, 409);
  const result = await (await adapterForPayment(payment)).close(payment.paymentNo);
  if (!result.closed) return presentPayment(payment);
  const updated = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE paymentNo = ${paymentNo} FOR UPDATE`;
    const current = await tx.payment.findUniqueOrThrow({ where: { paymentNo } });
    if (current.status === "SUCCESS" || current.status === "CLOSED") return current;
    assertPaymentTransition(current.status, "CLOSED");
    const closed = await tx.payment.update({ where: { id: current.id }, data: { status: "CLOSED", rawResponse: result.raw as Prisma.InputJsonValue, nextQueryAt: null } });
    await tx.paymentEvent.create({ data: {
      aggregateType: "PAYMENT", aggregateId: current.paymentNo, orderId: current.orderId, paymentId: current.id,
      type: "PAYMENT_CLOSED", source, payload: {},
    } });
    return closed;
  });
  // 关闭同样是终态：唤醒等待中的收银台，让页面立刻显示「已关闭」而不是等兜底轮询。
  publishPaymentChange(updated.paymentNo);
  return presentPayment(updated);
}

export async function handleAlipayWebhook(payload: Record<string, string>): Promise<void> {
  const payment = await db.payment.findUnique({ where: { paymentNo: payload.out_trade_no || "" } });
  if (!payment || payment.channel !== "ALIPAY") throw new AppError("PAYMENT_NOT_FOUND", "支付宝支付单不存在", 404);
  const result = await (await adapterForPayment(payment)).handleWebhook(payload);
  let callback;
  try {
    callback = await db.channelCallback.create({ data: {
      channel: "ALIPAY", eventKey: result.eventKey, paymentNo: result.paymentNo, verified: true, rawPayload: payload,
    } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      callback = await db.channelCallback.findUniqueOrThrow({ where: { channel_eventKey: { channel: "ALIPAY", eventKey: result.eventKey } } });
      if (callback.processed) return;
    } else {
      throw error;
    }
  }
  try {
    if (result.status === "SUCCESS") await markPaymentSucceeded(result, "ALIPAY_WEBHOOK");
    await db.channelCallback.update({ where: { id: callback.id }, data: { processed: true, processedAt: new Date() } });
  } catch (error) {
    await db.channelCallback.update({ where: { id: callback.id }, data: { errorMessage: errorMessage(error).slice(0, 500) } });
    throw error;
  }
}

export async function mockSucceed(paymentNo: string): Promise<Payment> {
  const payment = await db.payment.findUnique({ where: { paymentNo } });
  if (!payment || payment.channel !== "MOCK") throw new AppError("PAYMENT_NOT_FOUND", "模拟支付单不存在", 404);
  return markPaymentSucceeded({
    eventKey: `mock:${paymentNo}`, paymentNo, status: "SUCCESS", amount: payment.amount,
    channelTradeNo: `mock_${paymentNo}`, paidAt: new Date(), raw: { mock: "true" },
  }, "MOCK");
}

export async function publicPayment(paymentNo: string) {
  const payment = await db.payment.findUnique({ where: { paymentNo }, include: { order: true } });
  if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
  const access = cashierAccess(payment);
  return {
    paymentNo: payment.paymentNo,
    status: payment.status,
    channel: payment.channel,
    method: payment.method,
    amount: payment.channelAmount,
    businessAmount: payment.amount,
    currency: payment.order.currency,
    subject: payment.order.subject,
    clientPayload: access.payable ? payment.clientPayload : null,
    payable: access.payable,
    validUntil: access.validUntil,
    returnUrl: safeReturnUrl(payment.order.returnUrl),
    paidAt: payment.paidAt,
  };
}

export function presentPayment(payment: Payment) {
  return { ...payment, cashierUrl: `${config().WEB_PUBLIC_URL}/cashier/${payment.paymentNo}` };
}
