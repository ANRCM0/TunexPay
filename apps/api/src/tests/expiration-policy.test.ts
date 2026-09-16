import { describe, expect, it } from "vitest";
import { EXPIRATION_RETRY_INITIAL_SECONDS, EXPIRATION_RETRY_MAX_SECONDS, expirationRetryAt, expirationRetryDelaySeconds } from "../lib/expiration-policy.js";

describe("expiration policy", () => {
  it("uses bounded exponential retry delays", () => {
    expect(expirationRetryDelaySeconds(1)).toBe(EXPIRATION_RETRY_INITIAL_SECONDS);
    expect(expirationRetryDelaySeconds(2)).toBe(EXPIRATION_RETRY_INITIAL_SECONDS * 2);
    expect(expirationRetryDelaySeconds(99)).toBe(EXPIRATION_RETRY_MAX_SECONDS);
  });

  it("builds the next attempt from the supplied clock", () => {
    expect(expirationRetryAt(2, 1_000).getTime()).toBe(1_000 + EXPIRATION_RETRY_INITIAL_SECONDS * 2 * 1_000);
  });
});
