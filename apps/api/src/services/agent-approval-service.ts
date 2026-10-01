import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.js";
import { AppError } from "../lib/errors.js";
import { closePayment } from "./payment-service.js";
import { createRefund } from "./refund-service.js";
import { updatePaymentException } from "./payment-exception-service.js";

const ACTIONS = ["CLOSE_PAYMENT", "CREATE_REFUND", "RESOLVE_EXCEPTION"] as const;
export type AgentAction = typeof ACTIONS[number];

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function requestAgentAction(action: AgentAction, raw: unknown, requestedBy: string) {
  const id = `act_${randomUUID().replaceAll("-", "")}`;
  let args: Record<string, unknown>;
  let summary: string;

  if (action === "CLOSE_PAYMENT") {
    const input = z.object({ paymentNo: z.string().min(1).max(40), reason: z.string().trim().min(2).max(300) }).parse(raw);
    const payment = await db.payment.findUnique({ where: { paymentNo: input.paymentNo }, include: { order: true } });
    if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
    if (payment.status === "SUCCESS") throw new AppError("PAYMENT_ALREADY_SUCCESS", "成功支付不能通过 Agent 关闭", 409);
    args = input;
    summary = `关闭支付单 ${input.paymentNo}（订单 ${payment.order.orderNo}）：${input.reason}`;
  } else if (action === "CREATE_REFUND") {
    const input = z.object({ paymentNo: z.string().min(1).max(40), amount: z.number().int().positive().max(999_999_999), reason: z.string().trim().min(2).max(300) }).parse(raw);
    const payment = await db.payment.findUnique({ where: { paymentNo: input.paymentNo }, include: { order: true } });
    if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
    if (payment.status !== "SUCCESS") throw new AppError("PAYMENT_NOT_REFUNDABLE", "只有成功支付单可以申请退款", 409);
    args = { ...input, externalRefundNo: `agent_${id}` };
    summary = `退款 ${(input.amount / 100).toFixed(2)} 元：支付单 ${input.paymentNo}（订单 ${payment.order.orderNo}），原因：${input.reason}`;
  } else {
    const input = z.object({
      exceptionId: z.string().min(1).max(191),
      status: z.enum(["RESOLVED", "IGNORED"]),
      resolution: z.string().trim().min(2).max(500),
      resolutionRef: z.string().trim().max(80).optional(),
    }).parse(raw);
    const exception = await db.paymentException.findUnique({ where: { id: input.exceptionId } });
    if (!exception) throw new AppError("PAYMENT_EXCEPTION_NOT_FOUND", "支付异常不存在", 404);
    args = input;
    summary = `${input.status === "RESOLVED" ? "解决" : "忽略"}支付异常 ${exception.exceptionNo}：${input.resolution}`;
  }

  return db.agentActionApproval.create({
    data: {
      id, action, arguments: jsonValue(args), summary, requestedBy: requestedBy.slice(0, 120),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
  });
}

async function expirePending() {
  await db.agentActionApproval.updateMany({
    where: { status: "PENDING", expiresAt: { lte: new Date() } },
    data: { status: "EXPIRED" },
  });
}

export async function listAgentActions(limit = 50) {
  await expirePending();
  return db.agentActionApproval.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(100, Math.max(1, limit)) });
}

export async function rejectAgentAction(id: string, rejectedBy = "admin") {
  await expirePending();
  const changed = await db.agentActionApproval.updateMany({
    where: { id, status: "PENDING", expiresAt: { gt: new Date() } },
    data: { status: "REJECTED", rejectedAt: new Date(), approvedBy: rejectedBy.slice(0, 120) },
  });
  if (!changed.count) throw new AppError("AGENT_ACTION_NOT_PENDING", "该动作已处理或已过期", 409);
  return db.agentActionApproval.findUniqueOrThrow({ where: { id } });
}

export async function approveAgentAction(id: string, approvedBy = "admin") {
  await expirePending();
  const claimed = await db.agentActionApproval.updateMany({
    where: { id, status: "PENDING", expiresAt: { gt: new Date() } },
    data: { status: "APPROVED", approvedAt: new Date(), approvedBy: approvedBy.slice(0, 120) },
  });
  if (!claimed.count) throw new AppError("AGENT_ACTION_NOT_PENDING", "该动作已处理或已过期", 409);
  const action = await db.agentActionApproval.findUniqueOrThrow({ where: { id } });
  const args = action.arguments as Record<string, unknown>;
  try {
    let result: unknown;
    if (action.action === "CLOSE_PAYMENT") {
      const input = z.object({ paymentNo: z.string(), reason: z.string() }).parse(args);
      result = await closePayment(null, input.paymentNo, "AGENT_APPROVAL");
    } else if (action.action === "CREATE_REFUND") {
      const input = z.object({ paymentNo: z.string(), externalRefundNo: z.string(), amount: z.number().int().positive(), reason: z.string() }).parse(args);
      const payment = await db.payment.findUnique({ where: { paymentNo: input.paymentNo }, include: { order: { include: { application: true } } } });
      if (!payment) throw new AppError("PAYMENT_NOT_FOUND", "支付单不存在", 404);
      result = await createRefund(payment.order.application, input);
    } else if (action.action === "RESOLVE_EXCEPTION") {
      const input = z.object({ exceptionId: z.string(), status: z.enum(["RESOLVED", "IGNORED"]), resolution: z.string(), resolutionRef: z.string().optional() }).parse(args);
      result = await updatePaymentException(input.exceptionId, { status: input.status, resolution: input.resolution, resolutionRef: input.resolutionRef });
    } else {
      throw new AppError("AGENT_ACTION_UNSUPPORTED", "不支持的 Agent 动作", 409);
    }
    return db.agentActionApproval.update({ where: { id }, data: { status: "EXECUTED", executedAt: new Date(), result: jsonValue(result), lastError: null } });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await db.agentActionApproval.update({ where: { id }, data: { status: "FAILED", executedAt: new Date(), lastError: message.slice(0, 500) } });
    throw cause;
  }
}
