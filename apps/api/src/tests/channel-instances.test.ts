import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelInstance } from "@prisma/client";
const mocks = vi.hoisted(() => ({ find: vi.fn(), updateMany: vi.fn(), payment: vi.fn(), query: vi.fn(), logs: vi.fn(), create: vi.fn(), refund: vi.fn(), webhook: vi.fn(), settings: vi.fn(), upsert: vi.fn(), update: vi.fn(), count: vi.fn(), state: vi.fn(), siblings: vi.fn(), raw: vi.fn() }));
vi.mock("../db.js", () => {
  const tx = { channelInstance: { findUnique: mocks.find, findUniqueOrThrow: mocks.find, updateMany: mocks.updateMany, upsert: mocks.upsert, update: mocks.update, create: mocks.create, findMany: mocks.siblings }, payment: { findUnique: mocks.payment, count: mocks.count }, billChannelSettings: { upsert: mocks.upsert, findUniqueOrThrow: mocks.settings }, billCollectorState: { findUnique: mocks.state, updateMany: mocks.updateMany }, $queryRaw: mocks.raw };
  return { db: { ...tx, $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } };
});
vi.mock("../channels/alipay.js", () => ({ AlipayChannel: class {
  constructor(readonly settings: unknown) { configCapture.push(settings); }
  query = mocks.query; queryAccountLogs = mocks.logs; refund = mocks.refund; handleWebhook = mocks.webhook;
} }));
// Capture configuration at the adapter boundary, not environment defaults.
const configCapture = vi.hoisted(() => [] as unknown[]);
import { adapterForPayment, checkChannel, decodeChannel, mergeChannelSettings, publicChannel, saveChannel, verificationStatus } from "../services/channel-instance-service.js";
import { initialBillSettings } from "../services/bill-settings-service.js";
import { openSealed, seal } from "../lib/crypto.js";
import { resetConfigForTests } from "../config.js";
import { paymentChannelScope } from "../lib/channel-scope.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
let row: ChannelInstance;
const originalEnvironment = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks(); configCapture.length = 0;
  process.env.NODE_ENV = "test"; resetConfigForTests();
  const settings = { ...initialBillSettings(false), appId: "2026000000000001", privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
  row = { id: "chn-a", plugin: "ALIPAY", name: "Account A", enabled: true, revision: 2, payloadEncrypted: seal(JSON.stringify(settings)), checkStatus: "UNCHECKED", checkMessage: null, checkedAt: null, checkRevision: null, checkLease: null, checkLockedUntil: null, testPaymentNo: null, testRevision: null, createdAt: new Date(), updatedAt: new Date() };
  mocks.find.mockImplementation(async () => ({ ...row }));
  mocks.settings.mockResolvedValue({ revision: 1, updatedAt: new Date(), payloadEncrypted: seal(JSON.stringify(initialBillSettings(false))) });
  mocks.upsert.mockResolvedValue({}); mocks.count.mockResolvedValue(0); mocks.state.mockResolvedValue(null); mocks.siblings.mockResolvedValue([]); mocks.payment.mockResolvedValue(null);
  mocks.update.mockImplementation(async ({ data }) => { row = { ...row, ...data, revision: row.revision + 1 }; return row; });
  mocks.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.revision && where.revision !== row.revision) return { count: 0 };
    if (where.checkLease && where.checkLease !== row.checkLease) return { count: 0 };
    row = { ...row, ...data }; return { count: 1 };
  });
  mocks.query.mockResolvedValue({ status: "CREATED", raw: {} });
});
afterEach(() => { process.env = { ...originalEnvironment }; resetConfigForTests(); });

describe("plugin channel instances", () => {
  it("uses bound credentials for historical payments even when new orders are disabled", async () => {
    row.enabled = false;
    const adapter = await adapterForPayment({ channel: "ALIPAY", channelId: "chn-a" });
    await adapter.refund({ paymentNo: "old-payment", refundNo: "refund", amount: 1 });
    expect(configCapture.at(-1)).toMatchObject({ ALIPAY_APP_ID: "2026000000000001" });
    expect(mocks.refund).toHaveBeenCalled();
    expect(mocks.find).toHaveBeenCalledWith({ where: { id: "chn-a" } });
  });
  it("fails closed on missing bindings or plugin mismatch", async () => {
    mocks.find.mockResolvedValueOnce(null);
    await expect(adapterForPayment({ channel: "ALIPAY", channelId: "missing" })).rejects.toMatchObject({ code: "CHANNEL_BINDING_INVALID" });
    await expect(adapterForPayment({ channel: "MOCK", channelId: "chn-a" })).rejects.toMatchObject({ code: "CHANNEL_BINDING_INVALID" });
  });
  it("makes an upstream request and reports interface verification without claiming payment verification", async () => {
    const result = await checkChannel(row.id, row.revision);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringMatching(/^txp_check_/));
    expect(result.checkStatus).toBe("API_VERIFIED");
    expect(row.checkRevision).toBe(2); expect(row.checkLease).toBeNull();
  });
  it("records failures without exposing upstream payloads or secrets", async () => {
    mocks.query.mockRejectedValue(new Error("private-key-secret provider payload"));
    const result = await checkChannel(row.id, 2);
    expect(result.checkStatus).toBe("FAILED");
    expect(JSON.stringify(result)).not.toMatch(/private-key-secret|BEGIN PRIVATE KEY|payloadEncrypted/);
    expect(row.checkLockedUntil).toBeNull();
  });
  it("does not call a provider with a stale revision", async () => {
    await expect(checkChannel(row.id, 1)).rejects.toMatchObject({ code: "CHANNEL_CHECK_CONFLICT" });
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("never marks external Watcher settings as a live connection", async () => {
    row.plugin = "ALIPAY_BILL";
    mocks.settings.mockResolvedValue({ revision: 1, updatedAt: new Date(), payloadEncrypted: seal(JSON.stringify({ ...initialBillSettings(false), enabled: true, qrContent: "https://qr.alipay.com/a", watcherToken: "watcher-token-at-least-24-characters" })) });
    expect((await checkChannel(row.id, 2)).checkStatus).toBe("NEEDS_PAYMENT");
    expect(mocks.logs).not.toHaveBeenCalled();
  });
  it("rejects a corrupt or malformed bill page instead of declaring a working collector", async () => {
    row.plugin = "ALIPAY_BILL";
    mocks.settings.mockResolvedValue({ revision: 1, updatedAt: new Date(), payloadEncrypted: seal(JSON.stringify({ ...decodeChannel(row), enabled: true, collectorEnabled: true, userId: "2088000000000001", qrContent: "https://qr.alipay.com/a" })) });
    mocks.logs.mockResolvedValue({ total_size: 1, account_log_list: [] });
    expect((await checkChannel(row.id, 2)).checkStatus).toBe("FAILED");
    expect(mocks.logs).toHaveBeenCalledWith(expect.objectContaining({ bill_user_id: "2088000000000001" }));
  });
  it("only trusts successful test payments from the current channel and configuration", () => {
    row.testRevision = 2;
    const paid = { channelId: "chn-a", status: "SUCCESS", paidAt: new Date() };
    expect(verificationStatus(row, paid)).toBe("PAYMENT_VERIFIED");
    expect(verificationStatus(row, { ...paid, channelId: "chn-b" })).toBe("UNCHECKED");
    expect(verificationStatus({ ...row, revision: 3 }, paid)).toBe("UNCHECKED");
    expect(verificationStatus({ ...row, plugin: "MOCK" }, paid)).toBe("UNCHECKED");
    expect(verificationStatus({ ...row, checkStatus: "FAILED", checkRevision: 2, checkedAt: new Date(paid.paidAt.getTime() + 1000) }, paid)).toBe("FAILED");
  });
  it("encrypts edits, preserves blank secrets, and invalidates previous check and payment evidence", async () => {
    row.checkStatus = "API_VERIFIED"; row.checkRevision = 2; row.testRevision = 2;
    const previous = decodeChannel(row);
    await saveChannel({ name: "Renamed", plugin: "ALIPAY", enabled: true, revision: 2, settings: { privateKey: "", publicKey: "" } }, row.id);
    expect(JSON.parse(openSealed(row.payloadEncrypted)).privateKey.trim()).toBe(previous.privateKey.trim());
    expect(row).toMatchObject({ revision: 3, checkStatus: "UNCHECKED", checkRevision: null, testRevision: null });
    expect(row.payloadEncrypted).not.toContain("BEGIN PRIVATE KEY");
  });
  it("blocks replacing an account after it has payments", async () => {
    mocks.count.mockResolvedValue(1);
    await expect(saveChannel({ name: row.name, plugin: "ALIPAY", enabled: true, revision: 2, settings: { appId: "2026000000000002" } }, row.id)).rejects.toMatchObject({ code: "CHANNEL_ACCOUNT_CHANGE_BLOCKED" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects nonofficial gateway URLs before any outbound request", () => {
    expect(() => mergeChannelSettings("ALIPAY", decodeChannel(row), { gateway: "https://127.0.0.1/gateway.do" }, true)).toThrow();
    expect(() => mergeChannelSettings("ALIPAY", decodeChannel(row), { privateKey: "invalid" }, true)).toThrow();
  });
  it("redacts secrets in management views", async () => {
    const view = await publicChannel(row);
    expect(view.settings.privateKeyConfigured).toBe(true);
    expect(view.settings).not.toHaveProperty("privateKey");
    expect(view).not.toHaveProperty("payloadEncrypted");
  });
  it("limits null legacy payment bindings to the original account", () => {
    expect(paymentChannelScope("chn-b", "ALIPAY_BILL")).toEqual({ channel: "ALIPAY_BILL", channelId: "chn-b" });
    expect(paymentChannelScope("alipay-bill-default", "ALIPAY_BILL")).toMatchObject({ AND: [{ OR: [{ channelId: "alipay-bill-default" }, { channelId: null }] }] });
  });
});
