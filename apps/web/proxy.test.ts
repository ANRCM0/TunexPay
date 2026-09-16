import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdminSession } from "./lib/session";
import { proxy } from "./proxy";

const originalSecret = process.env.ADMIN_SESSION_SECRET;
const secret = "proxy-test-secret-that-is-at-least-32-characters";

afterEach(() => { process.env.ADMIN_SESSION_SECRET = originalSecret; });

describe("admin route protection", () => {
  it("redirects an unauthenticated page request to login", async () => {
    process.env.ADMIN_SESSION_SECRET = secret;
    const response = await proxy(new NextRequest("http://localhost/orders?status=SUCCESS"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login?next=%2Forders%3Fstatus%3DSUCCESS");
  });

  it("rejects an unauthenticated internal API request", async () => {
    process.env.ADMIN_SESSION_SECRET = secret;
    const response = await proxy(new NextRequest("http://localhost/api/backend/orders"));
    expect(response.status).toBe(401);
  });

  it("keeps cashier endpoints public and accepts a valid admin session", async () => {
    process.env.ADMIN_SESSION_SECRET = secret;
    const cashier = await proxy(new NextRequest("http://localhost/cashier/pay_test"));
    expect(cashier.headers.get("x-middleware-next")).toBe("1");

    const session = await createAdminSession(secret);
    const request = new NextRequest("http://localhost/orders", { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${session}` } });
    const response = await proxy(request);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
