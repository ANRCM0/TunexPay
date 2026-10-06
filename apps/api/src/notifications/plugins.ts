import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import nodemailer from "nodemailer";
import { z } from "zod";
import { sendWebhookRequest } from "../lib/webhook-security.js";
import { AppError } from "../lib/errors.js";
import type { NotificationPlugin } from "./types.js";

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

function mergeSecrets(raw: unknown, previous: Record<string, unknown> | undefined, secretFields: string[]): Record<string, unknown> {
  const next = { ...(previous ?? {}), ...record(raw) };
  const incoming = record(raw);
  for (const key of secretFields) {
    const value = incoming[key];
    if (value === undefined || value === "") next[key] = previous?.[key] ?? "";
    if (value === null) next[key] = "";
  }
  return next;
}

function publicConfig(config: Record<string, unknown>, secretFields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!secretFields.includes(key)) result[key] = value;
  }
  for (const key of secretFields) result[`${key}Configured`] = Boolean(config[key]);
  return result;
}

async function responseJson(response: Response, maxBytes = 64_000): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error("NOTIFICATION_RESPONSE_TOO_LARGE");
  if (!text) return {};
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new Error("NOTIFICATION_RESPONSE_INVALID_JSON"); }
}

function publicNetworkAddress(address: string): boolean {
  const blocked = new BlockList();
  for (const [ip, bits] of [["0.0.0.0",8],["10.0.0.0",8],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.168.0.0",16],["100.64.0.0",10],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(ip,bits,"ipv4");
  blocked.addAddress("::","ipv6"); blocked.addAddress("::1","ipv6"); blocked.addSubnet("fc00::",7,"ipv6"); blocked.addSubnet("fe80::",10,"ipv6"); blocked.addSubnet("ff00::",8,"ipv6");
  const family = isIP(address);
  return Boolean(family) && !blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

const smtpSchema = z.object({
  host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.-]+$/),
  port: z.union([z.literal(465), z.literal(587)]),
  user: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1000),
  from: z.email(),
  to: z.email(),
}).strict();

const smtp: NotificationPlugin = {
  code: "SMTP",
  name: "邮箱 SMTP",
  description: "通过安全 TLS SMTP 将支付事件发送到管理员邮箱。",
  capabilities: ["文本通知", "TLS", "公网 SMTP"],
  fields: [
    { key: "host", label: "SMTP 主机", type: "text", required: true, placeholder: "smtp.example.com" },
    { key: "port", label: "端口", type: "select", required: true, options: [{ value: "465", label: "465 · TLS" }, { value: "587", label: "587 · STARTTLS" }] },
    { key: "user", label: "登录账号", type: "text", required: true },
    { key: "password", label: "密码 / 授权码", type: "password", required: true, secret: true },
    { key: "from", label: "发件邮箱", type: "text", required: true },
    { key: "to", label: "收件邮箱", type: "text", required: true },
  ],
  normalizeConfig(raw, previous) { return smtpSchema.parse(mergeSecrets(raw, previous, ["password"])); },
  publicConfig(config) { return publicConfig(config, ["password"]); },
  async send(input, config) {
    const value = smtpSchema.parse(config);
    const addresses = await lookup(value.host, { all: true });
    if (!addresses.length || addresses.some(item => !publicNetworkAddress(item.address))) throw new Error("SMTP_ADDRESS_BLOCKED");
    const transport = nodemailer.createTransport({
      host: addresses[0]!.address, port: value.port, secure: value.port === 465, requireTLS: true,
      tls: { servername: value.host, rejectUnauthorized: true },
      auth: { user: value.user, pass: value.password },
      connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 10_000,
      disableFileAccess: true, disableUrlAccess: true,
    });
    try { await transport.sendMail({ from: value.from, to: value.to, subject: input.title, text: input.message }); }
    finally { transport.close(); }
  },
};

function validateFeishuWebhook(value: string): URL {
  if (!z.url().safeParse(value).success) throw new AppError("FEISHU_URL_INVALID", "请填写有效的飞书机器人地址", 422);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "open.feishu.cn" || url.port || url.username || url.password || url.search || url.hash || !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]{20,100}$/.test(url.pathname)) {
    throw new AppError("FEISHU_URL_INVALID", "仅允许飞书官方自定义机器人 HTTPS Webhook", 422);
  }
  return url;
}

const feishuBotSchema = z.object({ webhook: z.string().min(1).max(500), secret: z.string().max(300).default("") }).strict();
const feishuBot: NotificationPlugin = {
  code: "FEISHU_BOT",
  name: "飞书机器人",
  description: "飞书群自定义机器人，适合发送收款和异常提醒。",
  capabilities: ["群通知", "签名校验"],
  fields: [
    { key: "webhook", label: "Webhook", type: "password", required: true, secret: true },
    { key: "secret", label: "签名密钥（选填）", type: "password", secret: true },
  ],
  normalizeConfig(raw, previous) {
    const value = feishuBotSchema.parse(mergeSecrets(raw, previous, ["webhook", "secret"]));
    validateFeishuWebhook(value.webhook);
    return value;
  },
  publicConfig(config) { return publicConfig(config, ["webhook", "secret"]); },
  async send(input, config) {
    const value = feishuBotSchema.parse(config);
    const url = validateFeishuWebhook(value.webhook);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = value.secret ? createHmac("sha256", `${timestamp}\n${value.secret}`).update("").digest("base64") : undefined;
    const response = await fetch(url, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text: `${input.title}\n${input.message}` }, ...(sign ? { timestamp, sign } : {}) }),
    });
    const result = await responseJson(response, 16_000);
    const code = result.code ?? result.StatusCode;
    if (!response.ok || code !== 0) throw new Error("FEISHU_BOT_SEND_FAILED");
  },
};

const telegramSchema = z.object({
  botToken: z.string().trim().regex(/^\d{6,12}:[A-Za-z0-9_-]{30,80}$/),
  chatId: z.string().trim().regex(/^-?\d+$/),
  threadId: z.coerce.number().int().positive().nullable().optional(),
}).strict();
const telegram: NotificationPlugin = {
  code: "TELEGRAM",
  name: "Telegram Bot",
  description: "通过 Telegram Bot API 发送到私聊、群组或 Topic。",
  capabilities: ["私聊/群组", "Topic"],
  fields: [
    { key: "botToken", label: "Bot Token", type: "password", required: true, secret: true },
    { key: "chatId", label: "Chat ID", type: "text", required: true },
    { key: "threadId", label: "Thread ID（选填）", type: "number" },
  ],
  normalizeConfig(raw, previous) { return telegramSchema.parse(mergeSecrets(raw, previous, ["botToken"])); },
  publicConfig(config) { return publicConfig(config, ["botToken"]); },
  async send(input, config) {
    const value = telegramSchema.parse(config);
    const response = await fetch(`https://api.telegram.org/bot${value.botToken}/sendMessage`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: value.chatId, text: `${input.title}\n${input.message}`, ...(value.threadId ? { message_thread_id: value.threadId } : {}) }),
    });
    const result = await responseJson(response);
    if (!response.ok || result.ok !== true) throw new Error("TELEGRAM_SEND_FAILED");
  },
};

const webhookSchema = z.object({
  url: z.string().url().max(500),
  secret: z.string().max(500).default(""),
}).strict();
const webhook: NotificationPlugin = {
  code: "WEBHOOK",
  name: "通知 Webhook",
  description: "将管理员通知事件发送到独立自动化端点；与业务入账 Webhook 完全隔离。",
  capabilities: ["JSON POST", "HMAC-SHA256", "n8n/自动化"],
  fields: [
    { key: "url", label: "目标 URL", type: "text", required: true, placeholder: "https://notify.example.com/tuoxin" },
    { key: "secret", label: "签名密钥（选填）", type: "password", secret: true },
  ],
  normalizeConfig(raw, previous) { return webhookSchema.parse(mergeSecrets(raw, previous, ["secret"])); },
  publicConfig(config) { return publicConfig(config, ["secret"]); },
  async send(input, config) {
    const value = webhookSchema.parse(config);
    const body = JSON.stringify({ event: input.event, title: input.title, message: input.message, data: input.data ?? {}, createdAt: new Date().toISOString() });
    const signature = value.secret ? createHmac("sha256", value.secret).update(body).digest("hex") : "";
    const response = await sendWebhookRequest(value.url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "TuneXPay-Notification/1.0", ...(signature ? { "x-tunexpay-signature": `sha256=${signature}` } : {}) },
      body,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`NOTIFICATION_WEBHOOK_HTTP_${response.status}`);
  },
};

const feishuAppSchema = z.object({
  appId: z.string().trim().min(5).max(100),
  appSecret: z.string().min(8).max(500),
  receiveIdType: z.enum(["open_id", "user_id", "union_id", "email", "chat_id"]),
  receiveId: z.string().trim().min(1).max(200),
}).strict();
const feishuApp: NotificationPlugin = {
  code: "FEISHU_APP",
  name: "飞书应用",
  description: "使用企业自建应用身份发送消息，可投递给用户或群聊。",
  capabilities: ["应用身份", "用户/群消息"],
  fields: [
    { key: "appId", label: "App ID", type: "text", required: true },
    { key: "appSecret", label: "App Secret", type: "password", required: true, secret: true },
    { key: "receiveIdType", label: "接收 ID 类型", type: "select", required: true, options: [
      { value: "open_id", label: "open_id" }, { value: "user_id", label: "user_id" }, { value: "union_id", label: "union_id" }, { value: "email", label: "email" }, { value: "chat_id", label: "chat_id" },
    ] },
    { key: "receiveId", label: "接收 ID", type: "text", required: true },
  ],
  normalizeConfig(raw, previous) { return feishuAppSchema.parse(mergeSecrets(raw, previous, ["appSecret"])); },
  publicConfig(config) { return publicConfig(config, ["appSecret"]); },
  async send(input, config) {
    const value = feishuAppSchema.parse(config);
    const tokenResponse = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: value.appId, app_secret: value.appSecret }),
    });
    const tokenBody = await responseJson(tokenResponse);
    const token = typeof tokenBody.tenant_access_token === "string" ? tokenBody.tenant_access_token : "";
    if (!tokenResponse.ok || !token) throw new Error("FEISHU_APP_TOKEN_FAILED");
    const target = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
    target.searchParams.set("receive_id_type", value.receiveIdType);
    const sendResponse = await fetch(target, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: value.receiveId, msg_type: "text", content: JSON.stringify({ text: `${input.title}\n${input.message}` }) }),
    });
    const sendBody = await responseJson(sendResponse);
    if (!sendResponse.ok || sendBody.code !== 0) throw new Error("FEISHU_APP_SEND_FAILED");
  },
};

export const notificationPlugins: Record<string, NotificationPlugin> = Object.fromEntries(
  [smtp, feishuBot, telegram, webhook, feishuApp].map(plugin => [plugin.code, plugin]),
);

export function notificationPlugin(code: string): NotificationPlugin {
  const plugin = notificationPlugins[code];
  if (!plugin) throw new AppError("NOTIFICATION_PLUGIN_NOT_FOUND", "通知插件不存在", 404);
  return plugin;
}

export function notificationPluginCatalog() {
  return Object.values(notificationPlugins).map(({ normalizeConfig: _normalize, publicConfig: _public, send: _send, ...info }) => info);
}
