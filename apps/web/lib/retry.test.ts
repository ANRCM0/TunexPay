import { describe, expect, it } from "vitest";
import { RETRY_BASE_MS, RETRY_MAX_MS, retryDelayMs, sleep } from "./retry";

describe("retryDelayMs", () => {
  it("grows exponentially from the base delay", () => {
    const noJitter = () => 1;
    expect(retryDelayMs(1, noJitter)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(2, noJitter)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelayMs(3, noJitter)).toBe(RETRY_BASE_MS * 4);
  });

  it("never exceeds the cap, even after many failures", () => {
    const noJitter = () => 1;
    expect(retryDelayMs(6, noJitter)).toBe(RETRY_MAX_MS);
    expect(retryDelayMs(50, noJitter)).toBe(RETRY_MAX_MS);
  });

  it("spreads retries by keeping the delay inside [ceiling/2, ceiling]", () => {
    expect(retryDelayMs(3, () => 0)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelayMs(3, () => 1)).toBe(RETRY_BASE_MS * 4);
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = retryDelayMs(4, () => random);
      expect(delay).toBeGreaterThanOrEqual(RETRY_BASE_MS * 4);
      expect(delay).toBeLessThanOrEqual(RETRY_BASE_MS * 8);
    }
  });

  it("treats a zero or negative attempt as the first retry", () => {
    expect(retryDelayMs(0, () => 1)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(-5, () => 1)).toBe(RETRY_BASE_MS);
  });
});

describe("sleep", () => {
  it("resolves immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(60_000, controller.signal)).resolves.toBeUndefined();
  });

  it("resolves early when aborted mid-wait", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = sleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
