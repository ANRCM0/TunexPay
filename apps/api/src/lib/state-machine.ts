import type { OrderStatus, PaymentStatus, RefundStatus } from "@prisma/client";
import { AppError } from "./errors.js";

const paymentTransitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ["PROCESSING", "FAILED", "UNKNOWN", "CLOSED", "SUCCESS"],
  PROCESSING: ["FAILED", "UNKNOWN", "CLOSED", "SUCCESS"],
  UNKNOWN: ["PROCESSING", "FAILED", "CLOSED", "SUCCESS"],
  FAILED: ["SUCCESS"],
  CLOSED: ["SUCCESS"],
  SUCCESS: [],
};

const refundTransitions: Record<RefundStatus, readonly RefundStatus[]> = {
  CREATED: ["PROCESSING", "SUCCESS", "FAILED", "UNKNOWN"],
  PROCESSING: ["SUCCESS", "FAILED", "UNKNOWN"],
  UNKNOWN: ["PROCESSING", "SUCCESS", "FAILED"],
  FAILED: ["SUCCESS"],
  SUCCESS: [],
};

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canPaymentTransition(from, to)) throw new AppError("INVALID_PAYMENT_TRANSITION", `支付状态不允许从 ${from} 变为 ${to}`, 409);
}

export function canPaymentTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || paymentTransitions[from].includes(to);
}

export function assertRefundTransition(from: RefundStatus, to: RefundStatus): void {
  if (!canRefundTransition(from, to)) throw new AppError("INVALID_REFUND_TRANSITION", `退款状态不允许从 ${from} 变为 ${to}`, 409);
}

export function canRefundTransition(from: RefundStatus, to: RefundStatus): boolean {
  return from === to || refundTransitions[from].includes(to);
}

export function refundedOrderStatus(totalRefunded: number, orderAmount: number): OrderStatus {
  if (totalRefunded <= 0) throw new AppError("INVALID_REFUND_TOTAL", "退款累计金额必须大于 0");
  return totalRefunded >= orderAmount ? "REFUNDED" : "PARTIALLY_REFUNDED";
}
