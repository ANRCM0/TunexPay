import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./app/api/backend/[...path]/route";
const previous = process.env.WEB_PUBLIC_URL;
afterEach(() => { process.env.WEB_PUBLIC_URL = previous; vi.unstubAllGlobals(); });
describe("bill configuration origin protection", () => {
  it.each([["channel-instances"], ["channel-instances", "chn-a", "check"], ["channel-instances", "chn-a", "test-payment"], ["applications", "app-a", "channel-instance"]])("protects plugin-channel mutation %j", async (...path: string[]) => {
    process.env.WEB_PUBLIC_URL = "https://pay.example.com";
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await POST(new NextRequest(`https://pay.example.com/api/backend/${path.join("/")}`, { method: "POST", headers: { origin: "https://evil.example" } }), { params: Promise.resolve({ path }) });
    expect(response.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects cross-site owner notification tests before forwarding credentials", async () => {
    process.env.WEB_PUBLIC_URL = "https://pay.example.com";
    const fetch = vi.fn(); vi.stubGlobal("fetch",fetch);
    const response = await POST(new NextRequest("https://pay.example.com/api/backend/owner-notifications/test", {method:"POST",headers:{origin:"https://evil.example"}}), {params:Promise.resolve({path:["owner-notifications","test"]})});
    expect(response.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects cross-site writes before forwarding any credentials", async () => {
    process.env.WEB_PUBLIC_URL = "https://pay.example.com";
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await POST(new NextRequest("https://pay.example.com/api/backend/channels/alipay-bill/settings", { method: "POST", headers: { origin: "https://evil.example" } }), { params: Promise.resolve({ path: ["channels", "alipay-bill", "settings"] }) });
    expect(response.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });
  it("accepts the configured same-origin frontend write", async () => {
    process.env.WEB_PUBLIC_URL = "https://pay.example.com";
    const fetch = vi.fn(async () => new Response('{"data":{"revision":2}}', { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetch);
    const response = await POST(new NextRequest("http://web:3000/api/backend/channels/alipay-bill/settings", { method: "POST", headers: { origin: "https://pay.example.com", "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ path: ["channels", "alipay-bill", "settings"] }) });
    expect(response.status).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// 同源校验覆盖全部写操作，而不是只覆盖最初那几类配置接口。
describe("every state-changing write requires a trusted origin", () => {
  it.each([
    ["orders", "ord_1", "close"],
    ["refunds", "ref_1", "query"],
    ["webhooks", "wh_1", "retry"],
    ["exceptions", "exc_1", "resolve"],
    ["channels", "chn_1", "status"],
    ["reconciliation", "alipay", "rematch"],
    ["system", "refresh"],
  ])("rejects a cross-site POST to %j before forwarding credentials", async (...path: string[]) => {
    process.env.WEB_PUBLIC_URL = "https://pay.example.com";
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await POST(new NextRequest(`https://pay.example.com/api/backend/${path.join("/")}`, { method: "POST", headers: { origin: "https://evil.example" } }), { params: Promise.resolve({ path }) });
    expect(response.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a write that omits the Origin header entirely", async () => {
    process.env.WEB_PUBLIC_URL = "https://pay.example.com";
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await POST(new NextRequest("https://pay.example.com/api/backend/orders/ord_1/close", { method: "POST" }), { params: Promise.resolve({ path: ["orders", "ord_1", "close"] }) });
    expect(response.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });

  it("still forwards an in-app same-origin write", async () => {
    process.env.WEB_PUBLIC_URL = "https://pay.example.com";
    const fetch = vi.fn(async () => new Response('{"data":{}}', { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetch);
    const response = await POST(new NextRequest("http://web:3000/api/backend/orders/ord_1/close", { method: "POST", headers: { origin: "https://pay.example.com", "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ path: ["orders", "ord_1", "close"] }) });
    expect(response.status).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps read-only requests working without an Origin header", async () => {
    process.env.WEB_PUBLIC_URL = "https://pay.example.com";
    const fetch = vi.fn(async () => new Response('{"data":{}}', { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetch);
    const response = await GET(new NextRequest("https://pay.example.com/api/backend/public/payments/pay_1?wait=12"), { params: Promise.resolve({ path: ["public", "payments", "pay_1"] }) });
    expect(response.status).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
