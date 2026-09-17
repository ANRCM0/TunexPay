import { Prisma, type Application, type IntegrationProtocol } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.js";
import { generateId, sha256, stableJson } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";

export const createOrderSchema = z.object({
  externalOrderNo: z.string().trim().min(1).max(80),
  amount: z.number().int().positive().max(999_999_999),
  currency: z.literal("CNY").default("CNY"),
  subject: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  notifyUrl: z.string().url().max(500).optional(),
  returnUrl: z.string().url().max(500).optional(),
  expiresInSeconds: z.number().int().min(60).max(86_400).default(1_800),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export async function createOrder(
  application: Application,
  input: CreateOrderInput,
  idempotencyKey: string | undefined,
  protocol: IntegrationProtocol = "NATIVE_V1",
) {
  const normalizedKey = idempotencyKey?.trim() || null;
  if (normalizedKey && normalizedKey.length > 120) throw new AppError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 不能超过 120 个字符");
  const requestHash = sha256(stableJson({ ...input, protocol }));

  const existing = await db.order.findFirst({
    where: {
      applicationId: application.id,
      deletedAt: null,
      OR: [
        { externalOrderNo: input.externalOrderNo },
        ...(normalizedKey ? [{ idempotencyKey: normalizedKey }] : []),
      ],
    },
  });
  if (existing) {
    if (existing.requestHash !== requestHash) throw new AppError("IDEMPOTENCY_CONFLICT", "相同业务单号或幂等键对应了不同请求", 409);
    return { order: existing, reused: true };
  }

  try {
    const order = await db.$transaction(async (tx) => {
      const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1_000);
      const created = await tx.order.create({
        data: {
          orderNo: generateId("ord"),
          externalOrderNo: input.externalOrderNo,
          applicationId: application.id,
          amount: input.amount,
          currency: input.currency,
          subject: input.subject,
          description: input.description,
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
          notifyUrl: input.notifyUrl,
          returnUrl: input.returnUrl,
          protocol,
          idempotencyKey: normalizedKey,
          requestHash,
          expiresAt,
          expirationNextAttemptAt: expiresAt,
        },
      });
      await tx.paymentEvent.create({
        data: {
          aggregateType: "ORDER",
          aggregateId: created.orderNo,
          orderId: created.id,
          type: "ORDER_CREATED",
          source: protocol,
          payload: { amount: created.amount, currency: created.currency, externalOrderNo: created.externalOrderNo },
        },
      });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { order, reused: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await db.order.findFirst({
        where: {
          applicationId: application.id,
          deletedAt: null,
          OR: [{ externalOrderNo: input.externalOrderNo }, ...(normalizedKey ? [{ idempotencyKey: normalizedKey }] : [])],
        },
      });
      if (raced?.requestHash === requestHash) return { order: raced, reused: true };
      throw new AppError("IDEMPOTENCY_CONFLICT", "并发请求使用了相同业务单号或幂等键", 409);
    }
    throw error;
  }
}

// 业务侧只能看到在用的订单：随应用归档的订单已经「删除」，不该再出现在接口返回里。
export async function findApplicationOrder(applicationId: string, orderNo: string) {
  const order = await db.order.findFirst({
    where: { applicationId, orderNo, deletedAt: null },
    include: { payments: { orderBy: { attemptNo: "asc" } } },
  });
  if (!order) throw new AppError("ORDER_NOT_FOUND", "订单不存在", 404);
  return order;
}
