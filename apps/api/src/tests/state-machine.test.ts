import { describe, expect, it } from "vitest";
import { assertPaymentTransition, assertRefundTransition, refundedOrderStatus } from "../lib/state-machine.js";

describe("payment state machine", () => {
  it("permits uncertain and late-success recovery", () => {
    expect(() => assertPaymentTransition("PROCESSING", "UNKNOWN")).not.toThrow();
    expect(() => assertPaymentTransition("UNKNOWN", "SUCCESS")).not.toThrow();
    expect(() => assertPaymentTransition("CLOSED", "SUCCESS")).not.toThrow();
    expect(() => assertPaymentTransition("FAILED", "SUCCESS")).not.toThrow();
  });

  it("does not allow a successful payment to regress", () => {
    expect(() => assertPaymentTransition("SUCCESS", "FAILED")).toThrow("不允许");
  });

  it("models full and partial refunds", () => {
    expect(refundedOrderStatus(500, 1000)).toBe("PARTIALLY_REFUNDED");
    expect(refundedOrderStatus(1000, 1000)).toBe("REFUNDED");
    expect(() => assertRefundTransition("SUCCESS", "FAILED")).toThrow();
  });
});
