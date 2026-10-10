import { isIP, type LookupFunction } from "node:net";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { config } from "../config.js";
import { AppError } from "./errors.js";

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_RESPONSE_MAX_BYTES = 64 * 1024;

type Address = { address: string; family: 4 | 6 };
export type WebhookRequest = { method: "GET" | "POST"; headers?: Record<string, string>; body?: string };
export type WebhookResponse = { status: number; body: string };

function blockedIpv4(value: number): boolean {
  // Private, shared, link-local, documentation, benchmark, multicast and reserved ranges.
  const ranges: Array<[number, number]> = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
    [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
    [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
    [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
  ];
  return ranges.some(([network, bits]) => value >>> (32 - bits) === network >>> (32 - bits));
}

function ipv6Value(address: string): bigint {
  // WHATWG canonicalization also converts dotted IPv4 tails to hexadecimal words.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left = "", right] = canonical.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words = right === undefined ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

export function isPrivateAddress(address: string): boolean {
  if (address.includes("%")) return true; // Scoped addresses are interface-local, not public webhook targets.
  const family = isIP(address);
  if (family === 4) {
    const value = address.split(".").reduce((result, part) => result * 256 + Number(part), 0);
    return blockedIpv4(value);
  }
  if (family !== 6) return true; // Unknown/malformed resolver results fail closed.
  const value = ipv6Value(address);
  if (value >> 32n === 0xffffn) return blockedIpv4(Number(value & 0xffffffffn));
  // Only global unicast 2000::/3 can be public; exclude special-use allocations within it.
  if (value >> 125n !== 1n) return true;
  const reserved: Array<[bigint, number]> = [
    [ipv6Value("2001::"), 23],       // IETF protocol assignments, Teredo, ORCHID, benchmarks.
    [ipv6Value("2001:db8::"), 32],   // Documentation.
    [ipv6Value("2002::"), 16],       // Deprecated 6to4, including embedded private IPv4.
    [ipv6Value("3fff::"), 20],       // Documentation.
  ];
  return reserved.some(([network, bits]) => value >> BigInt(128 - bits) === network >> BigInt(128 - bits));
}

async function resolveWebhookTarget(value: string): Promise<{ url: URL; addresses: Address[] }> {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError("WEBHOOK_URL_BLOCKED", "Webhook 地址不合法"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new AppError("WEBHOOK_URL_BLOCKED", "Webhook 仅支持 HTTP/HTTPS");
  if (url.username || url.password) throw new AppError("WEBHOOK_URL_BLOCKED", "Webhook 地址不能包含用户名或密码");
  const allowPrivate = config().ALLOW_PRIVATE_WEBHOOKS;
  if (!allowPrivate && url.protocol !== "https:") throw new AppError("WEBHOOK_URL_BLOCKED", "生产环境 Webhook 只允许 HTTPS 地址");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const resolved = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname, { all: true, verbatim: true });
  const addresses: Address[] = resolved.map(({ address }) => {
    const family = isIP(address);
    if (family !== 4 && family !== 6) throw new AppError("WEBHOOK_URL_BLOCKED", "Webhook 地址解析结果不合法");
    return { address, family };
  });
  if (!addresses.length || (!allowPrivate && addresses.some(({ address }) => isPrivateAddress(address)))) {
    throw new AppError("WEBHOOK_URL_BLOCKED", "Webhook 地址解析到内网或保留地址");
  }
  return { url, addresses };
}

export function sendWebhookRequest(value: string, input: WebhookRequest): Promise<WebhookResponse> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    const finish = (error?: Error, result?: WebhookResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        response?.destroy();
        request?.destroy();
        reject(error);
      } else {
        resolve(result!);
      }
    };
    // A single deadline includes DNS, connect/TLS, response headers and the complete body.
    const timer = setTimeout(() => finish(new AppError("WEBHOOK_TIMEOUT", "Webhook 请求超过 10 秒", 502)), WEBHOOK_TIMEOUT_MS);
    void resolveWebhookTarget(value).then(({ url, addresses }) => {
      if (settled) return; // A DNS response after the deadline must not initiate a connection.
      const selected = addresses[0]!;
      const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
        if (options.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      };
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
        protocol: url.protocol,
        hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: input.method,
        headers: { ...input.headers, host: url.host },
        lookup: pinnedLookup,
        family: selected.family, // A fixed family also prevents automatic family selection/re-resolution.
        agent: false, // No pooled connection may bypass this delivery's address validation.
        ...(url.protocol === "https:" ? { servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true } : {}),
      }, (incoming) => {
        response = incoming;
        incoming.on("error", (error: Error) => finish(error));
        incoming.on("aborted", () => finish(new AppError("WEBHOOK_RESPONSE_ABORTED", "Webhook 响应被中断", 502)));
        if (settled) { incoming.destroy(); return; }
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          finish(new AppError("WEBHOOK_REDIRECT_BLOCKED", `Webhook 不允许重定向（HTTP ${status}）`, 502));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > WEBHOOK_RESPONSE_MAX_BYTES) {
            finish(new AppError("WEBHOOK_RESPONSE_TOO_LARGE", "Webhook 响应体不能超过 64 KiB", 502));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => finish(undefined, { status, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", (error: Error) => finish(error));
      request.end(input.body);
    }).catch((error: Error) => finish(error));
  });
}
