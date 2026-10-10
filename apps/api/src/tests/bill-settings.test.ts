import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("../db.js", () => {
  const tx = { billChannelSettings: { findUniqueOrThrow: mocks.find } };
  return { db: { ...tx, $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(tx) } };
});
import { billIdentity, billRuntimeConfig, getPublicBillSettings, mergeBillSettings, publicBillSettings, type BillSettings } from "../services/bill-settings-service.js";
import { seal } from "../lib/crypto.js";
import { resetConfigForTests } from "../config.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const initial: BillSettings = { enabled: false, collectorEnabled: false, appId: "2026000000000001", userId: "2088000000000000", gateway: "https://openapi.alipay.com/gateway.do", qrContent: "https://qr.alipay.com/example", matchMode: "REMARK", validSeconds: 300, amountOffsetMax: 99, pollSeconds: 10, lookbackSeconds: 3600, overlapSeconds: 300, lagSeconds: 15, privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), watcherToken: "a-long-watcher-token-123456789" };
let current: { revision: number; payloadEncrypted: string; updatedAt: Date };
function input(overrides: Record<string, unknown> = {}) {
  const { privateKey: _private, publicKey: _public, watcherToken: _token, ...values } = initial;
  return { ...values, revision: 1, privateKey: "", publicKey: "", watcherToken: "", ...overrides };
}
const previousEnvironment = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks(); process.env.NODE_ENV = "test"; resetConfigForTests();
  current = { revision: 1, payloadEncrypted: seal(JSON.stringify(initial)), updatedAt: new Date() };
  mocks.find.mockImplementation(async () => ({ ...current }));
});
afterEach(() => { process.env = { ...previousEnvironment }; resetConfigForTests(); });

// Saving configuration itself lives in channel-instances.test.ts (SAVE goes through
// saveChannel); this file covers reading, merging and validation only.
describe("panel bill settings", () => {
  it("never returns private/public keys, tokens, or encrypted payload", async () => {
    const view = await getPublicBillSettings();
    expect(view.privateKeyConfigured).toBe(true); expect(view.watcherTokenConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain(initial.privateKey);
    expect(view).not.toHaveProperty("privateKey"); expect(view).not.toHaveProperty("publicKey"); expect(view).not.toHaveProperty("watcherToken"); expect(view).not.toHaveProperty("payloadEncrypted");
  });
  it("reads the database on every access, overriding environment without resetting it", async () => {
    expect((await billRuntimeConfig()).ALIPAY_BILL_ENABLED).toBe(false);
    current.payloadEncrypted = seal(JSON.stringify({ ...initial, enabled: true, collectorEnabled: true, pollSeconds: 30 }));
    expect((await billRuntimeConfig()).ALIPAY_BILL_ENABLED).toBe(true);
    expect((await billRuntimeConfig()).ALIPAY_BILL_POLL_SECONDS).toBe(30);
  });
  it("allows stopping new payments while collecting existing payments", () => {
    expect(mergeBillSettings(initial, input({ enabled: false, collectorEnabled: true })).collectorEnabled).toBe(true);
  });
  it("rejects enabling collection without credentials and enables external-watcher mode separately", () => {
    expect(() => mergeBillSettings(initial, input({ collectorEnabled: true, privateKey: null }))).toThrow();
    expect(mergeBillSettings(initial, input({ enabled: true, collectorEnabled: false })).enabled).toBe(true);
    expect(() => mergeBillSettings(initial, input({ enabled: true, collectorEnabled: false, watcherToken: null }))).toThrow();
  });
  it("allows explicit secret clearing only if the remaining configuration is valid", () => {
    const result = mergeBillSettings(initial, input({ privateKey: null, publicKey: null, watcherToken: null }));
    expect(result.privateKey).toBe(""); expect(result.publicKey).toBe(""); expect(result.watcherToken).toBe("");
  });
  it("validates RSA2 material and accepts bare PKCS8 keys", () => {
    expect(() => mergeBillSettings(initial, input({ privateKey: "not-a-key" }))).toThrow();
    const bare = initial.privateKey.replace(/-----[^\n]+-----/g, "").trim();
    expect(mergeBillSettings(initial, input({ privateKey: bare })).privateKey).toContain("BEGIN PRIVATE KEY");
  });
  it("rejects arbitrary gateway destinations and invalid parameter ranges", () => {
    expect(() => mergeBillSettings(initial, input({ gateway: "https://attacker.example/gateway.do" }))).toThrow();
    expect(() => mergeBillSettings(initial, input({ gateway: "https://openapi.alipay.com/gateway.do?bad=1" }))).toThrow();
    expect(() => mergeBillSettings(initial, input({ pollSeconds: 0 }))).toThrow();
    expect(() => mergeBillSettings(initial, input({ watcherToken: "short" }))).toThrow();
  });
  it("allows parameter and key rotation without changing account identity", () => {
    expect(billIdentity(mergeBillSettings(initial, input({ pollSeconds: 20, publicKey: initial.publicKey })))).toBe(billIdentity(initial));
    expect(billIdentity(mergeBillSettings(initial, input({ userId: "2088000000000001" })))).not.toBe(billIdentity(initial));
  });
  it("fails closed on corrupt ciphertext without falling back to stale environment", async () => {
    current.payloadEncrypted = "corrupt";
    await expect(billRuntimeConfig()).rejects.toMatchObject({ code: "BILL_SETTINGS_UNREADABLE" });
  });
  it("reports empty secret flags accurately", () => {
    expect(publicBillSettings({ ...initial, privateKey: "", publicKey: "", watcherToken: "" }, 1, new Date())).toMatchObject({ privateKeyConfigured: false, publicKeyConfigured: false, watcherTokenConfigured: false });
  });
});
