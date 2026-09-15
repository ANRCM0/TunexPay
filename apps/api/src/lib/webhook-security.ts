import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { config } from "../config.js";
import { AppError } from "./errors.js";

export function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address === "::" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];
  const value = mapped ?? address;
  if (isIP(value) !== 4) return false;
  const [a = 0, b = 0] = value.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function assertSafeWebhookUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!config().ALLOW_PRIVATE_WEBHOOKS && url.protocol !== "https:") throw new AppError("WEBHOOK_URL_BLOCKED", "生产环境 Webhook 只允许 HTTPS 地址");
  if (!['http:', 'https:'].includes(url.protocol)) throw new AppError("WEBHOOK_URL_BLOCKED", "Webhook 仅支持 HTTP/HTTPS");
  if (config().ALLOW_PRIVATE_WEBHOOKS) return url;
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new AppError("WEBHOOK_URL_BLOCKED", "Webhook 地址解析到内网或保留地址");
  }
  return url;
}
