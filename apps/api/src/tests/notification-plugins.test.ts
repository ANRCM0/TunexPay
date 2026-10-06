import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn(), lookup: vi.fn(), transport: vi.fn(), mail: vi.fn() }));
vi.mock("../lib/webhook-security.js", () => ({ sendWebhookRequest: mocks.send }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.transport } }));
import { notificationPlugin, notificationPluginCatalog } from "../notifications/plugins.js";

const message = { event: "ORDER_SUCCEEDED", title: "title", message: "body" } as const;
const smtpConfig = { host: "smtp.example.com", port: 465, user: "user", password: "dummy-password", from: "from@example.com", to: "to@example.com" };
const feishuHook = "https://open.feishu.cn/open-apis/bot/v2/hook/11111111-1111-1111-1111-111111111111";

describe("notification plugins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.send.mockResolvedValue({ status: 200, body: "ok" });
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.transport.mockReturnValue({ sendMail: mocks.mail, close: vi.fn() });
    mocks.mail.mockResolvedValue({});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("masks the SMTP password and never returns it from publicConfig", () => {
    const plugin = notificationPlugin("SMTP");
    const config = plugin.normalizeConfig(smtpConfig);
    expect(plugin.publicConfig(config)).toMatchObject({ host: "smtp.example.com", passwordConfigured: true });
    expect(plugin.publicConfig(config)).not.toHaveProperty("password");
    expect(plugin.normalizeConfig({ ...smtpConfig, password: "" }, config).password).toBe("dummy-password");
  });
});

describe("SMTP plugin outbound hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transport.mockReturnValue({ sendMail: mocks.mail, close: vi.fn() });
    mocks.mail.mockResolvedValue({});
  });

  it("blocks private, link-local and mapped IPv6 SMTP destinations", async () => {
    const plugin = notificationPlugin("SMTP");
    for (const [address, family] of [["127.0.0.1", 4], ["10.0.0.1", 4], ["192.168.1.1", 4], ["169.254.1.1", 4], ["::1", 6], ["::ffff:7f00:1", 6], ["::ffff:a00:1", 6], ["fe90::1", 6], ["fd00::1", 6]] as const) {
      mocks.lookup.mockResolvedValueOnce([{ address, family }]);
      await expect(plugin.send(message, smtpConfig)).rejects.toThrow("SMTP_ADDRESS_BLOCKED");
    }
    // A hostname that resolves to nothing must fail closed as well.
    mocks.lookup.mockResolvedValueOnce([]);
    await expect(plugin.send(message, smtpConfig)).rejects.toThrow("SMTP_ADDRESS_BLOCKED");
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it("rejects the whole host when any resolved address is private", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await expect(notificationPlugin("SMTP").send(message, smtpConfig)).rejects.toThrow("SMTP_ADDRESS_BLOCKED");
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it("pins the resolved address with verified TLS and implicit TLS on 465", async () => {
    await notificationPlugin("SMTP").send(message, smtpConfig);
    expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({
      host: "8.8.8.8", port: 465, secure: true, requireTLS: true,
      tls: { servername: "smtp.example.com", rejectUnauthorized: true },
      auth: { user: "user", pass: "dummy-password" },
      disableFileAccess: true, disableUrlAccess: true,
    }));
    expect(mocks.mail).toHaveBeenCalledWith(expect.objectContaining({ from: "from@example.com", to: "to@example.com", subject: "title", text: "body" }));
  });

  it("uses STARTTLS instead of implicit TLS on 587", async () => {
    await notificationPlugin("SMTP").send(message, { ...smtpConfig, port: 587 });
    expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({ port: 587, secure: false, requireTLS: true }));
  });
});

describe("FEISHU_BOT plugin outbound hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs requests with the timestamp/secret HMAC and checks the business ack", async () => {
    const fetch = vi.fn(async () => new Response('{"code":0}'));
    vi.stubGlobal("fetch", fetch);
    await notificationPlugin("FEISHU_BOT").send(message, { webhook: feishuHook, secret: "secret" });
    const [, init] = fetch.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const body = JSON.parse(init.body as string) as { msg_type: string; content: { text: string }; timestamp: string; sign: string };
    expect(body.msg_type).toBe("text");
    expect(body.content.text).toBe("title\nbody");
    expect(body.sign).toBe(createHmac("sha256", `${body.timestamp}\nsecret`).update("").digest("base64"));
  });

  it("rejects provider failures despite HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"code":19021}')));
    await expect(notificationPlugin("FEISHU_BOT").send(message, { webhook: feishuHook, secret: "secret" })).rejects.toThrow("FEISHU_BOT_SEND_FAILED");
  });

  it("omits the signature when no secret is configured", async () => {
    const fetch = vi.fn(async () => new Response('{"code":0}'));
    vi.stubGlobal("fetch", fetch);
    await notificationPlugin("FEISHU_BOT").send(message, { webhook: feishuHook, secret: "" });
    const body = JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("sign");
    expect(body).not.toHaveProperty("timestamp");
  });

  it("rejects arbitrary webhook hosts, credentials, query strings and paths", async () => {
    const plugin = notificationPlugin("FEISHU_BOT");
    const rejection = (webhook: string) => {
      try {
        plugin.normalizeConfig({ webhook, secret: "" });
      } catch (error) {
        return error as { code?: string };
      }
      throw new Error(`expected ${webhook} to be rejected`);
    };
    for (const webhook of [
      "http://open.feishu.cn/open-apis/bot/v2/hook/11111111111111111111",
      "https://evil.example/hook/11111111111111111111",
      `${feishuHook}?redirect=1`,
      "https://user@open.feishu.cn/open-apis/bot/v2/hook/11111111111111111111",
      "https://open.feishu.cn:8443/open-apis/bot/v2/hook/11111111111111111111",
    ]) {
      expect(rejection(webhook)).toMatchObject({ code: "FEISHU_URL_INVALID" });
    }
  });
});
