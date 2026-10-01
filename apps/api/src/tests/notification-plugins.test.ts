import { describe, expect, it } from "vitest";
import { notificationPlugin, notificationPluginCatalog } from "../notifications/plugins.js";

describe("notification plugins", () => {
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
