import { createSign, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const cfg = vi.hoisted(() => ({ ALIPAY_APP_ID: "app", ALIPAY_PRIVATE_KEY: "", ALIPAY_PUBLIC_KEY: "", ALIPAY_GATEWAY: "https://openapi.alipay.com/gateway.do", ALIPAY_SIGN_TYPE: "RSA2" }));
vi.mock("../config.js", () => ({ config: () => cfg }));
import { AlipayChannel } from "../channels/alipay.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
beforeEach(() => {
  cfg.ALIPAY_PRIVATE_KEY = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  cfg.ALIPAY_PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
});
afterEach(() => vi.unstubAllGlobals());
function signedResponse(values: Record<string, unknown>) {
  const content = JSON.stringify({ code: "10000", trade_status: "TRADE_SUCCESS", trade_no: "t1", ...values });
  const signer = createSign("RSA-SHA256");
  signer.update(content); signer.end();
  return `{"alipay_trade_query_response":${content},"sign":${JSON.stringify(signer.sign(keys.privateKey, "base64"))}}`;
}

describe("signed Alipay query amount", () => {
  it.each(["TRADE_SUCCESS", "TRADE_FINISHED"])("extracts integer cents for %s from the verified response", async trade_status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(signedResponse({ total_amount: "12.34", trade_status }))));
    expect(await new AlipayChannel().query("pay_1")).toMatchObject({ status: "SUCCESS", amount: 1234, channelTradeNo: "t1" });
  });
  it.each([undefined, "", "0.00", "-1.00", "1.001", "not-money"])("blocks a successful response with invalid total_amount %s", async total_amount => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(signedResponse({ total_amount }))));
    await expect(new AlipayChannel().query("pay_1")).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });
  it("does not require an amount for an unpaid response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(signedResponse({ trade_status: "WAIT_BUYER_PAY" }))));
    const result = await new AlipayChannel().query("pay_1");
    expect(result.status).toBe("PROCESSING");
    expect(result).not.toHaveProperty("amount");
  });
  it("still rejects tampering with the signed amount", async () => {
    const body = signedResponse({ total_amount: "12.34" }).replace('"total_amount":"12.34"', '"total_amount":"12.35"');
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(new AlipayChannel().query("pay_1")).rejects.toThrow("验签失败");
  });
});
