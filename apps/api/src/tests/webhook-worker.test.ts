import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "../lib/webhook-security.js";
import { retryDelaySeconds } from "../services/webhook-worker-service.js";

describe("webhook delivery safety", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fd00::1"])("blocks private address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it("uses bounded exponential backoff", () => {
    expect(retryDelaySeconds(1, 0.5)).toBe(5);
    expect(retryDelaySeconds(2, 0.5)).toBe(10);
    expect(retryDelaySeconds(20, 0.5)).toBe(3600);
  });
});
