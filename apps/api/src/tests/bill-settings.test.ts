import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ upsert: vi.fn(), find: vi.fn(), update: vi.fn(), raw: vi.fn(), count: vi.fn(), state: vi.fn(), wake: vi.fn() }));
vi.mock("../db.js", () => {
  const tx = { billChannelSettings: { upsert: mocks.upsert, findUniqueOrThrow: mocks.find, update: mocks.update }, $queryRaw: mocks.raw, payment: { count: mocks.count }, billCollectorState: { findUnique: mocks.state, updateMany: mocks.wake } };
  return { db: { ...tx, $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(tx) } };
});
import { billIdentity, billRuntimeConfig, getPublicBillSettings, mergeBillSettings, publicBillSettings, saveBillSettings, type BillSettings } from "../services/bill-settings-service.js";
import { openSealed, seal } from "../lib/crypto.js";
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
  mocks.upsert.mockResolvedValue(current); mocks.find.mockImplementation(async () => ({ ...current }));
  mocks.update.mockImplementation(async ({ data }) => { current = { revision: current.revision + 1, payloadEncrypted: data.payloadEncrypted, updatedAt: new Date() }; return current; });
  mocks.count.mockResolvedValue(0); mocks.state.mockResolvedValue(null); mocks.wake.mockResolvedValue({ count: 0 });
});
afterEach(() => { process.env = { ...previousEnvironment }; resetConfigForTests(); });

describe("panel bill settings", () => {
  it("never returns private/public keys, tokens, or encrypted payload", async () => {
    const view = await getPublicBillSettings();
    expect(view.privateKeyConfigured).toBe(true); expect(view.watcherTokenConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain(initial.privateKey);
    expect(view).not.toHaveProperty("privateKey"); expect(view).not.toHaveProperty("publicKey"); expect(view).not.toHaveProperty("watcherToken"); expect(view).not.toHaveProperty("payloadEncrypted");
  });
  it("preserves blank secrets and persists encrypted settings", async () => {
    await saveBillSettings(input({ enabled: true, collectorEnabled: true }));
    const stored = JSON.parse(openSealed(current.payloadEncrypted));
    expect(stored.privateKey.trim()).toBe(initial.privateKey.trim()); expect(stored.watcherToken).toBe(initial.watcherToken); expect(stored.enabled).toBe(true);
    expect(current.payloadEncrypted).not.toContain(initial.privateKey); expect(current.revision).toBe(2);
    expect(mocks.raw).toHaveBeenCalled();
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
  it("rejects stale revisions without writing", async () => {
    await expect(saveBillSettings(input({ revision: 2 }))).rejects.toMatchObject({ code: "BILL_SETTINGS_CONFLICT" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("blocks account changes when payment history or collector state exists", async () => {
    mocks.count.mockResolvedValue(1);
    await expect(saveBillSettings(input({ userId: "2088000000000001" }))).rejects.toMatchObject({ code: "BILL_ACCOUNT_CHANGE_BLOCKED" });
    mocks.count.mockResolvedValue(0); mocks.state.mockResolvedValue({ id: "alipay-bill-default" });
    await expect(saveBillSettings(input({ qrContent: "different-qr" }))).rejects.toMatchObject({ code: "BILL_ACCOUNT_CHANGE_BLOCKED" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("allows parameter and key rotation without changing account identity", async () => {
    mocks.count.mockResolvedValue(1); mocks.state.mockResolvedValue({ id: "alipay-bill-default" });
    const view = await saveBillSettings(input({ pollSeconds: 20, publicKey: initial.publicKey }));
    expect(view.pollSeconds).toBe(20); expect(mocks.wake).toHaveBeenCalled();
    expect(billIdentity(mergeBillSettings(initial, input({ pollSeconds: 20 })))).toBe(billIdentity(initial));
  });
  it("fails closed on corrupt ciphertext without falling back to stale environment", async () => {
    current.payloadEncrypted = "corrupt";
    await expect(billRuntimeConfig()).rejects.toMatchObject({ code: "BILL_SETTINGS_UNREADABLE" });
  });
  it("reports empty secret flags accurately", () => {
    expect(publicBillSettings({ ...initial, privateKey: "", publicKey: "", watcherToken: "" }, 1, new Date())).toMatchObject({ privateKeyConfigured: false, publicKeyConfigured: false, watcherTokenConfigured: false });
  });
});
