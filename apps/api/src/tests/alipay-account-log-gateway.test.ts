import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const cfg = vi.hoisted(() => ({ ALIPAY_APP_ID: "app", ALIPAY_PRIVATE_KEY: "", ALIPAY_PUBLIC_KEY: "", ALIPAY_GATEWAY: "https://openapi.alipay.com/gateway.do", ALIPAY_SIGN_TYPE: "RSA2" }));
vi.mock("../config.js", () => ({ config: () => cfg }));
import { AlipayChannel, alipayCanonical } from "../channels/alipay.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const providerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
beforeEach(() => {
  cfg.ALIPAY_PRIVATE_KEY = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  cfg.ALIPAY_PUBLIC_KEY = providerKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
});
afterEach(() => vi.unstubAllGlobals());
function signedBody(content: string) {
  const signer = createSign("RSA-SHA256"); signer.update(content); signer.end();
  return `{"alipay_data_bill_accountlog_query_response":${content},"sign":${JSON.stringify(signer.sign(providerKeys.privateKey, "base64"))}}`;
}
describe("signed accountlog gateway", () => {
  it("signs the exact accountlog method and accepts a verified raw response", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const params = Object.fromEntries((init.body as URLSearchParams).entries());
      expect(params.method).toBe("alipay.data.bill.accountlog.query");
      expect(JSON.parse(params.biz_content!)).toMatchObject({ bill_user_id: "2088000000000000", page_no: 1 });
      const verifier = createVerify("RSA-SHA256"); verifier.update(alipayCanonical(params)); verifier.end();
      expect(verifier.verify(keys.publicKey, params.sign!, "base64")).toBe(true);
      return new Response(signedBody('{ "code": "10000", "total_size": 0, "account_log_list": [] }'));
    }));
    const result = await new AlipayChannel().queryAccountLogs({ bill_user_id: "2088000000000000", page_no: 1 });
    expect(result.total_size).toBe(0);
  });
  it("rejects a tampered ledger response", async () => {
    const body = signedBody('{"code":"10000","total_size":0,"account_log_list":[]}').replace('"total_size":0', '"total_size":1');
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(new AlipayChannel().queryAccountLogs({})).rejects.toThrow("验签失败");
  });
  it("uses the database credential snapshot instead of the process environment", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const params = Object.fromEntries((init.body as URLSearchParams).entries());
      expect(params.app_id).toBe("database-app");
      const verifier = createVerify("RSA-SHA256"); verifier.update(alipayCanonical(params)); verifier.end();
      expect(verifier.verify(providerKeys.publicKey, params.sign!, "base64")).toBe(true);
      return new Response(signedBody('{"code":"10000","total_size":0,"account_log_list":[]}'));
    }));
    const runtime = { ...cfg, ALIPAY_SIGN_TYPE: "RSA2" as const, ALIPAY_APP_ID: "database-app", ALIPAY_PRIVATE_KEY: providerKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    expect((await new AlipayChannel(runtime).queryAccountLogs({})).code).toBe("10000");
  });
  it("reports a signed permission failure rather than an empty ledger", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(signedBody('{"code":"40006","sub_code":"isv.insufficient-isv-permissions","sub_msg":"权限不足"}'))));
    await expect(new AlipayChannel().queryAccountLogs({})).rejects.toMatchObject({ code: "isv.insufficient-isv-permissions" });
  });
});
