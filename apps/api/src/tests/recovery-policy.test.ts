import { describe, expect, it } from "vitest";
import { RECOVERY_INITIAL_DELAY_SECONDS, RECOVERY_MAX_DELAY_SECONDS, initialRecoveryAt, isRecoverablePayment, recoveryAt, recoveryDelaySeconds } from "../lib/recovery-policy.js";

describe("recovery policy", () => {
  // 只有支付单参与自动查单：这里没有 isRecoverableRefund，退款不再被自动轮询。
  it("only schedules uncertain or processing payments", () => {
    expect(isRecoverablePayment("PROCESSING")).toBe(true);
    expect(isRecoverablePayment("UNKNOWN")).toBe(true);
    expect(isRecoverablePayment("SUCCESS")).toBe(false);
  });

  it("uses bounded exponential backoff", () => {
    expect(recoveryDelaySeconds(1, 0.5)).toBe(RECOVERY_INITIAL_DELAY_SECONDS);
    expect(recoveryDelaySeconds(2, 0.5)).toBe(RECOVERY_INITIAL_DELAY_SECONDS * 2);
    expect(recoveryDelaySeconds(99, 0.5)).toBe(RECOVERY_MAX_DELAY_SECONDS);
  });

  it("creates the first due time from the supplied clock", () => {
    expect(initialRecoveryAt(1_000).getTime()).toBe(1_000 + RECOVERY_INITIAL_DELAY_SECONDS * 1_000);
    expect(recoveryAt(2, 1_000, 0.5).getTime()).toBe(1_000 + RECOVERY_INITIAL_DELAY_SECONDS * 2 * 1_000);
  });
});
