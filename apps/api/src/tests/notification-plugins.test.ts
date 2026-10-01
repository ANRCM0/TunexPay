import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../lib/webhook-security.js", () => ({ sendWebhookRequest: mocks.send }));
import { notificationPlugin, notificationPluginCatalog } from "../notifications/plugins.js";

describe("notification plugins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.send.mockResolvedValue({ status: 200, body: "ok" });
  });

  it("sends the unchanged notification body and signature through the pinned transport", async () => {
    await notificationPlugin("WEBHOOK").send({ event: "payment.succeeded", title: "收款", message: "已到账", data: { amount: 100 } }, { url: "https://example.com/hook", secret: "notify-secret" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [url, input] = mocks.send.mock.calls[0]!;
    expect(url).toBe("https://example.com/hook");
    expect(input.method).toBe("POST");
    expect(JSON.parse(input.body)).toMatchObject({ event: "payment.succeeded", title: "收款", message: "已到账", data: { amount: 100 } });
    expect(input.headers["x-tunexpay-signature"]).toBe(`sha256=${createHmac("sha256", "notify-secret").update(input.body).digest("hex")}`);
  });

  it("does not add a signature when the notification secret is absent", async () => {
    await notificationPlugin("WEBHOOK").send({ event: "payment.succeeded", title: "test", message: "test" }, { url: "https://example.com/hook", secret: "" });
    expect(mocks.send.mock.calls[0]![1].headers).not.toHaveProperty("x-tunexpay-signature");
  });

  it("propagates address rejection and non-success HTTP results", async () => {
    const plugin = notificationPlugin("WEBHOOK");
    const message = { event: "payment.succeeded", title: "test", message: "test" };
    const config = { url: "https://example.com/hook", secret: "" };
    mocks.send.mockRejectedValueOnce(new Error("WEBHOOK_URL_BLOCKED"));
    await expect(plugin.send(message, config)).rejects.toThrow("WEBHOOK_URL_BLOCKED");
    mocks.send.mockResolvedValueOnce({ status: 503, body: "unavailable" });
    await expect(plugin.send(message, config)).rejects.toThrow("NOTIFICATION_WEBHOOK_HTTP_503");
  });

  it("publishes the five built-in plugins", () => {
    expect(notificationPluginCatalog().map(plugin => plugin.code).sort()).toEqual(["FEISHU_APP", "FEISHU_BOT", "SMTP", "TELEGRAM", "WEBHOOK"].sort());
  });

  it("masks and retains Telegram bot tokens", () => {
    const plugin = notificationPlugin("TELEGRAM");
    const initial = plugin.normalizeConfig({ botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_123456", chatId: "-1001234567890" });
    expect(plugin.publicConfig(initial)).toMatchObject({ chatId: "-1001234567890", botTokenConfigured: true });
    expect(plugin.publicConfig(initial)).not.toHaveProperty("botToken");
    const updated = plugin.normalizeConfig({ chatId: "-1009999999999" }, initial);
    expect(updated.botToken).toBe(initial.botToken);
    expect(updated.chatId).toBe("-1009999999999");
  });

  it("keeps a notification webhook secret unless explicitly cleared", () => {
    const plugin = notificationPlugin("WEBHOOK");
    const initial = plugin.normalizeConfig({ url: "https://example.com/hook", secret: "secret-value" });
    expect(plugin.normalizeConfig({ url: "https://example.com/next", secret: "" }, initial).secret).toBe("secret-value");
    expect(plugin.normalizeConfig({ url: "https://example.com/next", secret: null }, initial).secret).toBe("");
  });
});
