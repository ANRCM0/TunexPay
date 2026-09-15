import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1).default("mysql://tuoxin:change-me@127.0.0.1:3306/tuoxin_pay"),
  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),
  API_PUBLIC_URL: z.string().url().default("http://localhost:3001"),
  WEB_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  ADMIN_TOKEN: z.string().min(24).default("development-admin-token-change-me"),
  SECRETS_ENCRYPTION_KEY: z.string().default("0000000000000000000000000000000000000000000000000000000000000000"),
  ALIPAY_APP_ID: z.string().default(""),
  ALIPAY_PRIVATE_KEY: z.string().default(""),
  ALIPAY_PUBLIC_KEY: z.string().default(""),
  ALIPAY_GATEWAY: z.string().url().default("https://openapi.alipay.com/gateway.do"),
  ALIPAY_SIGN_TYPE: z.literal("RSA2").default("RSA2"),
  MOCK_CHANNEL_ENABLED: z.string().default("false").transform((value) => value === "true"),
  MOCK_CHANNEL_TOKEN: z.string().default(""),
  ALLOW_PRIVATE_WEBHOOKS: z.string().default("false").transform((value) => value === "true"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof envSchema>;
let cached: Config | undefined;

export function config(): Config {
  if (!cached) {
    const parsed = envSchema.parse(process.env);
    const encodedKey = parsed.SECRETS_ENCRYPTION_KEY;
    const decodedKey = /^[a-f\d]{64}$/i.test(encodedKey) ? Buffer.from(encodedKey, "hex") : Buffer.from(encodedKey, "base64");
    if (decodedKey.length !== 32) throw new Error("SECRETS_ENCRYPTION_KEY must encode exactly 32 bytes");
    if (parsed.NODE_ENV === "production") {
      if (parsed.ADMIN_TOKEN === "development-admin-token-change-me" || parsed.ADMIN_TOKEN.startsWith("replace-with")) throw new Error("ADMIN_TOKEN must be changed in production");
      if (/^0{64}$/.test(encodedKey) || encodedKey.startsWith("replace-with")) throw new Error("SECRETS_ENCRYPTION_KEY must be changed in production");
      if (parsed.MOCK_CHANNEL_ENABLED && !parsed.MOCK_CHANNEL_TOKEN) throw new Error("MOCK_CHANNEL_TOKEN is required when the mock channel is enabled");
      if (parsed.MOCK_CHANNEL_ENABLED && parsed.MOCK_CHANNEL_TOKEN === "local-development-only") throw new Error("MOCK_CHANNEL_TOKEN must be changed in production");
    }
    cached = parsed;
  }
  return cached;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
