import { describe, expect, it } from "vitest";
import { HEAVY_SCAN_MAX_STRIDE, WORKER_TICK_MS, heavyScanStride } from "../lib/worker-policy.js";

describe("worker polling cadence", () => {
  it("keeps the tick at 3 seconds", () => {
    expect(WORKER_TICK_MS).toBe(3_000);
  });

  it("does not back off while the worker is busy", () => {
    expect(heavyScanStride(0)).toBe(1);
    expect(heavyScanStride(1)).toBe(1);
    expect(heavyScanStride(2)).toBe(1);
  });

  it("widens the slow-path interval as idle ticks accumulate", () => {
    expect(heavyScanStride(3)).toBe(2);
    expect(heavyScanStride(5)).toBe(2);
    expect(heavyScanStride(6)).toBe(3);
    expect(heavyScanStride(9)).toBe(4);
  });

  it("caps the slow path at 15 seconds", () => {
    expect(heavyScanStride(12)).toBe(HEAVY_SCAN_MAX_STRIDE);
    expect(heavyScanStride(1_000)).toBe(HEAVY_SCAN_MAX_STRIDE);
    expect(WORKER_TICK_MS * HEAVY_SCAN_MAX_STRIDE).toBe(15_000);
  });

  it("treats a negative idle count as not idle", () => {
    expect(heavyScanStride(-5)).toBe(1);
  });
});
