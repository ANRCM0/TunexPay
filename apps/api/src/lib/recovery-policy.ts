import type { PaymentStatus, RefundStatus } from "@prisma/client";

export const RECOVERY_MAX_ATTEMPTS = 20;
export const RECOVERY_INITIAL_DELAY_SECONDS = 15;
export const RECOVERY_MAX_DELAY_SECONDS = 15 * 60;

export function isRecoverablePayment(status: PaymentStatus): boolean {
  return status === "PROCESSING" || status === "UNKNOWN";
}

export function isRecoverableRefund(status: RefundStatus): boolean {
  return status === "PROCESSING" || status === "UNKNOWN";
}

export function initialRecoveryAt(now = Date.now()): Date {
  return new Date(now + RECOVERY_INITIAL_DELAY_SECONDS * 1_000);
}

export function recoveryAt(attempt: number, now = Date.now(), random = Math.random()): Date {
  return new Date(now + recoveryDelaySeconds(attempt, random) * 1_000);
}

export function recoveryDelaySeconds(attempt: number, random = Math.random()): number {
  const exponential = RECOVERY_INITIAL_DELAY_SECONDS * 2 ** Math.min(Math.max(0, attempt - 1), 6);
  const base = Math.min(RECOVERY_MAX_DELAY_SECONDS, exponential);
  return Math.max(RECOVERY_INITIAL_DELAY_SECONDS, Math.round(base * (0.9 + random * 0.2)));
}
