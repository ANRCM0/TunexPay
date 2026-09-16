import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { alipayCanonical, extractTopLevelObject, mapRefundQueryStatus, verifyAlipaySignature } from "../channels/alipay.js";
import { epayCanonical, epaySign, openSealed, seal, verifyEpaySign, webhookSignature } from "../lib/crypto.js";

describe("secret handling and signatures", () => {
  it("encrypts application secrets with authenticated encryption", () => {
    const encrypted = seal("super-secret");
    expect(encrypted).not.toContain("super-secret");
    expect(openSealed(encrypted)).toBe("super-secret");
  });

  it("uses the ePay V1 canonical parameter order", () => {
    const params = { money: "19.99", pid: "1001", sign_type: "MD5", name: "套餐", empty: "", key: "must-not-be-signed" };
    expect(epayCanonical(params)).toBe("money=19.99&name=套餐&pid=1001");
    const signed = { ...params, sign: epaySign(params, "key") };
    expect(verifyEpaySign(signed, "key")).toBe(true);
    expect(verifyEpaySign({ ...signed, money: "29.99" }, "key")).toBe(false);
  });

  it("signs native webhooks over timestamp and exact body", () => {
    expect(webhookSignature("secret", "1700000000", "{}"))
      .toBe("b8569b78799ff9e3cbff0fc2d63a33a2b57f3282abd07c37ae5e8e7d79a5f163");
  });

  it("verifies an Alipay RSA2 callback", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const payload: Record<string, string> = { app_id: "20260001", out_trade_no: "pay_1", total_amount: "19.99", trade_status: "TRADE_SUCCESS", sign_type: "RSA2" };
    const signer = createSign("RSA-SHA256");
    signer.update(alipayCanonical(payload)); signer.end();
    payload.sign = signer.sign(privateKey, "base64");
    expect(verifyAlipaySignature(payload, publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(true);
    expect(verifyAlipaySignature({ ...payload, total_amount: "29.99" }, publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false);
  });

  it("extracts the exact signed response object without reserializing it", () => {
    const body = '{"alipay_trade_query_response" : {"code":"10000","nested":{"text":"a}b"}},"sign":"x"}';
    expect(extractTopLevelObject(body, "alipay_trade_query_response")).toBe('{"code":"10000","nested":{"text":"a}b"}}');
  });

  it("maps Alipay refund query amounts without treating an absent refund as success", () => {
    expect(mapRefundQueryStatus("19.99")).toBe("SUCCESS");
    expect(mapRefundQueryStatus("0.00")).toBe("PROCESSING");
    expect(mapRefundQueryStatus(undefined)).toBe("PROCESSING");
  });
});
