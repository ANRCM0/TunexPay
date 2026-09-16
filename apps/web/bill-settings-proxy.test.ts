import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./app/api/backend/[...path]/route";
const previous = process.env.WEB_PUBLIC_URL;
afterEach(() => { process.env.WEB_PUBLIC_URL = previous; vi.unstubAllGlobals(); });
describe("bill configuration origin protection", () => {
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
