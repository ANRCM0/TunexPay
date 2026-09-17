import type { ApplicationStatus, PaymentChannelCode } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { generateId, randomSecret, seal, sha256 } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { loadChannel, assertChannelVerified } from "./channel-instance-service.js";

// 通道实付验收用的内部应用由 channel-test-service 自动创建，不出现在应用列表里，也不允许从管理端启停或删除。
export const INTERNAL_APPLICATION_ID = "channel-diagnostics";

export type ApplicationCredentials = { apiKey: string; webhookSecret: string; epayKey: string };

export type CreateApplicationInput = {
  name: string;
  webhookUrl?: string | null;
  defaultChannel?: PaymentChannelCode;
  defaultChannelId?: string;
};

function numericPid(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(1_000_000_000 + (bytes[0]! % 9_000_000_000));
}

export async function createApplication(input: CreateApplicationInput) {
  const channel = input.defaultChannelId ? await loadChannel(input.defaultChannelId) : null;
  if (channel) await assertChannelVerified(channel);
  const appId = generateId("app");
  const apiKey = `txp_${appId}_${randomSecret(24)}`;
  const webhookSecret = `whsec_${randomSecret(32)}`;
  const epayKey = randomSecret(24);
  const application = await db.$transaction(async tx => {
    if (channel) {
      await tx.$queryRaw`SELECT id FROM channel_instances WHERE id = ${channel.id} FOR UPDATE`;
      const current = await tx.channelInstance.findUniqueOrThrow({ where: { id: channel.id } });
      if (!current.enabled || current.revision !== channel.revision) throw new AppError("CHANNEL_CONFIG_CONFLICT", "通道配置已变更，请重新加载", 409);
      await assertChannelVerified(current, tx);
    }
    return tx.application.create({
    data: {
      appId,
      name: input.name,
      webhookUrl: input.webhookUrl || null,
      defaultChannel: channel?.plugin ?? input.defaultChannel ?? "MOCK",
      defaultChannelId: channel?.id,
      apiKeyHash: sha256(apiKey),
      webhookSecretEncrypted: seal(webhookSecret),
      epayPid: numericPid(),
      epayKeyEncrypted: seal(epayKey),
    },
    });
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

// 重置该应用的全部凭据：接口鉴权 Key、回调验签密钥、ePay 商户密钥。
// epayPid 保持不换：它是商户标识而不是密钥，轮换只会让对端已配置的商户号失效，安全收益为零。
export async function rotateApplicationCredentials(id: string): Promise<ApplicationCredentials> {
  const application = await db.application.findUnique({ where: { id } });
  if (!application) throw new AppError("APPLICATION_NOT_FOUND", "应用不存在", 404);
  const apiKey = `txp_${application.appId}_${randomSecret(24)}`;
  const webhookSecret = `whsec_${randomSecret(32)}`;
  const epayKey = randomSecret(24);
  await db.application.update({
    where: { id },
    data: { apiKeyHash: sha256(apiKey), webhookSecretEncrypted: seal(webhookSecret), epayKeyEncrypted: seal(epayKey) },
  });
  return { apiKey, webhookSecret, epayKey };
}

export async function updateApplicationStatus(id: string, status: ApplicationStatus) {
  const application = await db.application.findUnique({ where: { id } });
  if (!application) throw new AppError("APPLICATION_NOT_FOUND", "应用不存在", 404);
  if (application.appId === INTERNAL_APPLICATION_ID) throw new AppError("APPLICATION_INTERNAL", "通道验收用的内部应用不参与启停", 409);
  if (application.status === status) return application;
  return db.application.update({ where: { id }, data: { status } });
}

// 删除应用分两种：没有业务数据的直接删行；承载过订单、退款、通知投递的走归档删除，
// 行保留（历史订单、事件、退款推进与异常记录仍挂在它上面），但对业务侧立即等同于删除。
export async function deleteApplication(id: string) {
  const application = await db.application.findUnique({
    where: { id },
    select: { appId: true, name: true, _count: { select: { orders: true, refunds: true, webhookDeliveries: true } } },
  });
  if (!application) throw new AppError("APPLICATION_NOT_FOUND", "应用不存在", 404);
  if (application.appId === INTERNAL_APPLICATION_ID) throw new AppError("APPLICATION_INTERNAL", "通道验收用的内部应用不允许删除", 409);
  if (application._count.orders || application._count.refunds || application._count.webhookDeliveries) {
    return archiveApplication(id);
  }
  try {
    await db.application.delete({ where: { id } });
  } catch (error) {
    // 计数与删除之间若并发落进一笔新订单，外键会拦住删除；这时改走归档，而不是把删除挡回去。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") return archiveApplication(id);
    throw error;
  }
  return { appId: application.appId, name: application.name, archived: false as const, cleared: emptyCleared() };
}

export type ArchivedApplication = {
  appId: string;
  name: string;
  archived: true;
  cleared: { orders: number; payments: number; refunds: number; events: number; webhookDeliveries: number; exceptions: number; receipts: number };
};

function emptyCleared(): ArchivedApplication["cleared"] {
  return { orders: 0, payments: 0, refunds: 0, events: 0, webhookDeliveries: 0, exceptions: 0, receipts: 0 };
}

// 归档删除：一次事务内把该应用从在用数据集里摘干净。
// 凭证重新随机、状态置 DISABLED、archivedAt / pausedAt 记录归档时刻；该应用下的订单打上 deletedAt，
// 尚未成功的支付尝试、未投递的通知、未处置的异常与回执线索一并清掉；已成功的支付与已发起的退款保留行。
// 行本身不删，DBA 可以按 orders.deletedWithApplicationId 把整批数据还原。
async function archiveApplication(id: string): Promise<ArchivedApplication> {
  return db.$transaction(async (tx) => {
    const application = await tx.application.findUniqueOrThrow({ where: { id }, select: { appId: true, name: true } });
    const orderIds = (await tx.order.findMany({ where: { applicationId: id, deletedAt: null }, select: { id: true } })).map(row => row.id);
    const subjectWhere = { OR: [{ orderId: { in: orderIds } }, { payment: { orderId: { in: orderIds } } }] };
    const [receipts, events, deliveries, exceptions, payments, refunds] = await Promise.all([
      tx.receipt.findMany({ where: { OR: [{ payment: { orderId: { in: orderIds } } }, { refund: { applicationId: id } }] }, select: { id: true } }),
      tx.paymentEvent.count({ where: subjectWhere }),
      tx.webhookDelivery.count({ where: { applicationId: id } }),
      tx.paymentException.count({ where: subjectWhere }),
      tx.payment.count({ where: { orderId: { in: orderIds } } }),
      tx.refund.count({ where: { applicationId: id } }),
    ]);
    // 成功的支付单与已发起的退款要留在库里：通道侧的钱已经动了，删掉就再也对不上账。
    const keptPayments = (await tx.payment.findMany({
      where: { orderId: { in: orderIds }, status: { in: ["SUCCESS", "CLOSED"] } },
      select: { id: true },
    })).map(row => row.id);
    const keptRefunds = (await tx.refund.findMany({ where: { applicationId: id, status: { in: ["SUCCESS", "PROCESSING", "UNKNOWN"] } }, select: { id: true } })).map(row => row.id);
    const archivedAt = new Date();

    await tx.receipt.deleteMany({ where: { id: { in: receipts.map(row => row.id) } } });
    await tx.paymentEvent.deleteMany({ where: subjectWhere });
    await tx.paymentException.deleteMany({ where: subjectWhere });
    await tx.refund.deleteMany({ where: { applicationId: id, id: { notIn: keptRefunds } } });
    await tx.webhookDelivery.deleteMany({ where: { applicationId: id } });
    await tx.payment.deleteMany({ where: { orderId: { in: orderIds }, id: { notIn: keptPayments } } });
    await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { deletedAt: archivedAt, deletedWithApplicationId: application.appId } });
    await tx.application.update({
      where: { id },
      data: {
        status: "DISABLED",
        archivedAt,
        pausedAt: archivedAt,
        apiKeyHash: sha256(randomSecret(32)),
        webhookSecretEncrypted: seal(randomSecret(32)),
        epayKeyEncrypted: seal(randomSecret(32)),
        webhookUrl: null,
      },
    });
    return {
      appId: application.appId,
      name: application.name,
      archived: true as const,
      cleared: {
        orders: orderIds.length,
        payments: payments - keptPayments.length,
        refunds: refunds - keptRefunds.length,
        events,
        webhookDeliveries: deliveries,
        exceptions,
        receipts: receipts.length,
      },
    };
  });
}
