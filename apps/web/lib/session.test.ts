import { describe, expect, it } from "vitest";
import { ADMIN_SESSION_TTL_SECONDS, createAdminSession, verifyAdminSession } from "./session";

const secret = "session-test-secret-that-is-at-least-32-characters";
const now = 1_800_000_000_000;

describe("admin session", () => {
  it("accepts a valid signed session before expiry", async () => {
    const session = await createAdminSession(secret, now);
    expect(await verifyAdminSession(session, secret, now + 1_000)).toBe(true);
  });

  it("rejects tampering and a different secret", async () => {
    const session = await createAdminSession(secret, now);
    const [payload, signature] = session.split(".") as [string, string];
    const tampered = `${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect(await verifyAdminSession(tampered, secret, now)).toBe(false);
    expect(await verifyAdminSession(session, `${secret}-wrong`, now)).toBe(false);
  });

  it("rejects an expired session", async () => {
    const session = await createAdminSession(secret, now);
    expect(await verifyAdminSession(session, secret, now + ADMIN_SESSION_TTL_SECONDS * 1_000)).toBe(false);
  });
});
