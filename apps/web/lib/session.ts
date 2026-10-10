export const ADMIN_SESSION_COOKIE = "tuoxin_admin_session";
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;

type SessionPayload = { version: 1; issuedAt: number; expiresAt: number };

export async function createAdminSession(secret: string, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const payload: SessionPayload = { version: 1, issuedAt, expiresAt: issuedAt + ADMIN_SESSION_TTL_SECONDS };
  const encoded = textToBase64Url(JSON.stringify(payload));
  return `${encoded}.${await sign(encoded, secret)}`;
}

export async function verifyAdminSession(value: string | undefined, secret: string, now = Date.now()): Promise<boolean> {
  if (!value || !secret) return false;
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra) return false;
  try {
    const key = await hmacKey(secret, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, base64UrlToBytes(signature), new TextEncoder().encode(encoded));
    if (!valid) return false;
    const payload = JSON.parse(base64UrlToText(encoded)) as Partial<SessionPayload>;
    const current = Math.floor(now / 1000);
    return payload.version === 1
      && Number.isInteger(payload.issuedAt)
      && Number.isInteger(payload.expiresAt)
      && Number(payload.issuedAt) <= current + 60
      && Number(payload.expiresAt) > current;
  } catch {
    return false;
  }
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await hmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function hmacKey(secret: string, usages: KeyUsage[]) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function textToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToText(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
