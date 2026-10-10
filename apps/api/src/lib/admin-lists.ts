import { Prisma } from "@prisma/client";
import { z } from "zod";

// 搜索和排序必须在数据库分页之前完成，否则只能查到前 100 条中的匹配项。
// 只允许白名单列；稳定的 id 次序避免同金额/同时间的数据在翻页时随机抖动。
const direction = z.enum(["asc", "desc"]).default("desc");
const search = z.string().trim().max(160).default("");

const orderParams = z.object({
  q: search,
  status: z.enum(["CREATED", "PENDING", "SUCCESS", "CLOSED", "PARTIALLY_REFUNDED", "REFUNDED"]).optional(),
  sortBy: z.enum(["subject", "application", "amount", "status", "createdAt"]).default("createdAt"),
  sortDir: direction,
});

const refundParams = z.object({
  q: search,
  status: z.enum(["CREATED", "PROCESSING", "SUCCESS", "FAILED", "UNKNOWN"]).optional(),
  sortBy: z.enum(["refundNo", "paymentNo", "amount", "status", "createdAt"]).default("createdAt"),
  sortDir: direction,
});

export function buildOrderListQuery(input: Record<string, string | undefined>) {
  const { q, status, sortBy, sortDir } = orderParams.parse(input);
  const where: Prisma.OrderWhereInput = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(q ? { OR: [
      { subject: { contains: q } },
      { orderNo: { contains: q } },
      { externalOrderNo: { contains: q } },
      { application: { name: { contains: q } } },
    ] } : {}),
  };
  const by: Record<typeof sortBy, Prisma.OrderOrderByWithRelationInput> = {
    subject: { subject: sortDir },
    application: { application: { name: sortDir } },
    amount: { amount: sortDir },
    status: { status: sortDir },
    createdAt: { createdAt: sortDir },
  };
  return { where, orderBy: [by[sortBy], { id: "desc" }] satisfies Prisma.OrderOrderByWithRelationInput[] };
}

export function buildRefundListQuery(input: Record<string, string | undefined>) {
  const { q, status, sortBy, sortDir } = refundParams.parse(input);
  const where: Prisma.RefundWhereInput = {
    ...(status ? { status } : {}),
    ...(q ? { OR: [
      { refundNo: { contains: q } },
      { externalRefundNo: { contains: q } },
      { payment: { paymentNo: { contains: q } } },
      { payment: { order: { subject: { contains: q } } } },
    ] } : {}),
  };
  const by: Record<typeof sortBy, Prisma.RefundOrderByWithRelationInput> = {
    refundNo: { refundNo: sortDir },
    paymentNo: { payment: { paymentNo: sortDir } },
    amount: { amount: sortDir },
    status: { status: sortDir },
    createdAt: { createdAt: sortDir },
  };
  return { where, orderBy: [by[sortBy], { id: "desc" }] satisfies Prisma.RefundOrderByWithRelationInput[] };
}
