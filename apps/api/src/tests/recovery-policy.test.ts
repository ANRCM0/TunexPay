import { describe, expect, it } from "vitest";
import { RECOVERY_INITIAL_DELAY_SECONDS, RECOVERY_MAX_DELAY_SECONDS, initialRecoveryAt, isRecoverablePayment, isRecoverableRefund, recoveryAt, recoveryDelaySeconds } from "../lib/recovery-policy.js";

describe("recovery policy", () => {
  it("only schedules uncertain or processing records", () => {
    expect(isRecoverablePayment("PROCESSING")).toBe(true);
    expect(isRecoverablePayment("UNKNOWN")).toBe(true);
    expect(isRecoverablePayment("SUCCESS")).toBe(false);
    expect(isRecoverableRefund("UNKNOWN")).toBe(true);
    expect(isRecoverableRefund("FAILED")).toBe(false);
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
