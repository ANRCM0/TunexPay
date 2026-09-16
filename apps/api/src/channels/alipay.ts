import { createSign, createVerify } from "node:crypto";
import type { PaymentStatus } from "@prisma/client";
import { config } from "../config.js";
import { ChannelDefinitiveError, ChannelUncertainError } from "../lib/errors.js";
import { centsToYuan, yuanToCents } from "../lib/money.js";
import type {
  ChannelCreateInput,
  ChannelCreateResult,
  ChannelQueryResult,
  ChannelRefundInput,
  ChannelRefundQueryInput,
  ChannelRefundResult,
  ChannelWebhookResult,
  PaymentChannel,
} from "./types.js";

type AlipayEnvelope = Record<string, unknown> & { code?: string; msg?: string; sub_code?: string; sub_msg?: string };

function pem(value: string): string {
  return value.replace(/\\n/g, "\n").trim();
}

function timestamp(): string {
  const date = new Date(Date.now() + 8 * 3_600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export function alipayCanonical(params: Record<string, string>): string {
  return Object.entries(params)
    .filter(([key, value]) => key !== "sign" && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function signParams(params: Record<string, string>): string {
  const signer = createSign("RSA-SHA256");
  signer.update(alipayCanonical(params), "utf8");
  signer.end();
  return signer.sign(pem(config().ALIPAY_PRIVATE_KEY), "base64");
}

export function verifyAlipaySignature(payload: Record<string, string>, publicKey = config().ALIPAY_PUBLIC_KEY): boolean {
  if (!payload.sign || !publicKey) return false;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(alipayCanonical(Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "sign_type"))), "utf8");
  verifier.end();
  return verifier.verify(pem(publicKey), payload.sign, "base64");
}

function mapTradeStatus(status: unknown): PaymentStatus {
  if (status === "TRADE_SUCCESS" || status === "TRADE_FINISHED") return "SUCCESS";
  if (status === "TRADE_CLOSED") return "CLOSED";
  return "PROCESSING";
}

export function mapRefundQueryStatus(refundAmount: unknown): "SUCCESS" | "PROCESSING" {
  return Number(refundAmount ?? 0) > 0 ? "SUCCESS" : "PROCESSING";
}

export class AlipayChannel implements PaymentChannel {
  readonly code = "ALIPAY" as const;

  async queryAccountLogs(bizContent: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("alipay.data.bill.accountlog.query", bizContent);
  }

  async create(input: ChannelCreateInput): Promise<ChannelCreateResult> {
    const response = await this.call("alipay.trade.precreate", {
      out_trade_no: input.paymentNo,
      total_amount: centsToYuan(input.amount),
      subject: input.subject,
      body: input.description || undefined,
      timeout_express: "30m",
    }, input.notifyUrl);
    const qrCode = String(response.qr_code ?? "");
    if (!qrCode) throw new ChannelDefinitiveError("ALIPAY_MISSING_QR", "支付宝未返回二维码", response);
    return {
      status: "PROCESSING",
      channelOrderNo: String(response.out_trade_no ?? input.paymentNo),
      clientPayload: { type: "qr_code", value: qrCode },
      raw: response,
    };
  }

  async query(paymentNo: string): Promise<ChannelQueryResult> {
    try {
      const response = await this.call("alipay.trade.query", { out_trade_no: paymentNo });
      return {
        status: mapTradeStatus(response.trade_status),
        channelTradeNo: response.trade_no ? String(response.trade_no) : undefined,
        paidAt: response.send_pay_date ? new Date(String(response.send_pay_date).replace(" ", "T") + "+08:00") : undefined,
        raw: response,
      };
    } catch (error) {
      if (error instanceof ChannelDefinitiveError && error.code === "ACQ.TRADE_NOT_EXIST") {
        return { status: "CREATED", raw: error.details };
      }
      throw error;
    }
  }

  async close(paymentNo: string): Promise<{ closed: boolean; raw: unknown }> {
    const response = await this.call("alipay.trade.close", { out_trade_no: paymentNo });
    return { closed: true, raw: response };
  }

  async refund(input: ChannelRefundInput): Promise<ChannelRefundResult> {
    const response = await this.call("alipay.trade.refund", {
      ...(input.channelTradeNo ? { trade_no: input.channelTradeNo } : { out_trade_no: input.paymentNo }),
      refund_amount: centsToYuan(input.amount),
      out_request_no: input.refundNo,
      refund_reason: input.reason || "TUOXIN Pay refund",
    });
    return {
      status: "SUCCESS",
      channelRefundNo: String(response.trade_no ?? input.channelTradeNo ?? ""),
      raw: response,
    };
  }

  async queryRefund(input: ChannelRefundQueryInput): Promise<ChannelRefundResult> {
    try {
      const response = await this.call("alipay.trade.fastpay.refund.query", {
        ...(input.channelTradeNo ? { trade_no: input.channelTradeNo } : { out_trade_no: input.paymentNo }),
        out_request_no: input.refundNo,
      });
      return {
        status: mapRefundQueryStatus(response.refund_amount),
        channelRefundNo: response.trade_no ? String(response.trade_no) : undefined,
        raw: response,
      };
    } catch (error) {
      if (error instanceof ChannelDefinitiveError && ["ACQ.TRADE_NOT_EXIST", "ACQ.REFUND_NOT_EXIST"].includes(error.code)) {
        return { status: "PROCESSING", raw: error.details };
      }
      throw error;
    }
  }

  async handleWebhook(payload: Record<string, string>): Promise<ChannelWebhookResult> {
    if (!verifyAlipaySignature(payload)) throw new ChannelDefinitiveError("INVALID_ALIPAY_SIGNATURE", "支付宝回调验签失败");
    if (payload.app_id !== config().ALIPAY_APP_ID) throw new ChannelDefinitiveError("INVALID_ALIPAY_APP", "支付宝回调 app_id 与当前配置不一致");
    const paymentNo = payload.out_trade_no ?? "";
    const amount = yuanToCents(payload.total_amount ?? "0");
    if (!paymentNo) throw new ChannelDefinitiveError("INVALID_ALIPAY_CALLBACK", "支付宝回调缺少 out_trade_no");
    return {
      eventKey: payload.notify_id || `${payload.trade_no}:${payload.trade_status}`,
      paymentNo,
      status: mapTradeStatus(payload.trade_status),
      amount,
      channelTradeNo: payload.trade_no,
      paidAt: payload.gmt_payment ? new Date(payload.gmt_payment.replace(" ", "T") + "+08:00") : undefined,
      raw: payload,
    };
  }

  private async call(method: string, bizContent: Record<string, unknown>, notifyUrl?: string): Promise<AlipayEnvelope> {
    const cfg = config();
    if (!cfg.ALIPAY_APP_ID || !cfg.ALIPAY_PRIVATE_KEY || !cfg.ALIPAY_PUBLIC_KEY) {
      throw new ChannelDefinitiveError("ALIPAY_NOT_CONFIGURED", "支付宝通道尚未配置");
    }
    const params: Record<string, string> = {
      app_id: cfg.ALIPAY_APP_ID,
      method,
      format: "JSON",
      charset: "utf-8",
      sign_type: cfg.ALIPAY_SIGN_TYPE,
      timestamp: timestamp(),
      version: "1.0",
      biz_content: JSON.stringify(bizContent),
    };
    if (notifyUrl) params.notify_url = notifyUrl;
    params.sign = signParams(params);

    let response: Response;
    try {
      response = await fetch(cfg.ALIPAY_GATEWAY, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      throw new ChannelUncertainError("支付宝请求超时或网络异常，结果需要主动查询", { cause: String(error) });
    }
    if (!response.ok) throw new ChannelUncertainError(`支付宝网关返回 HTTP ${response.status}`);
    const rawBody = await response.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new ChannelUncertainError("支付宝网关返回了无法解析的响应");
    }
    const key = `${method.replaceAll(".", "_")}_response`;
    const signature = typeof data.sign === "string" ? data.sign : "";
    const signedContent = extractTopLevelObject(rawBody, key);
    if (!signature || !signedContent || !verifyAlipayContent(signedContent, signature, cfg.ALIPAY_PUBLIC_KEY)) {
      throw new ChannelUncertainError("支付宝响应验签失败，结果需要主动查询");
    }
    const envelope = (data[key] ?? {}) as AlipayEnvelope;
    if (envelope.code !== "10000") {
      throw new ChannelDefinitiveError(String(envelope.sub_code ?? envelope.code ?? "ALIPAY_ERROR"), String(envelope.sub_msg ?? envelope.msg ?? "支付宝请求失败"), envelope);
    }
    return envelope;
  }
}

function verifyAlipayContent(content: string, signature: string, publicKey: string): boolean {
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(content, "utf8");
    verifier.end();
    return verifier.verify(pem(publicKey), signature, "base64");
  } catch {
    return false;
  }
}

export function extractTopLevelObject(json: string, key: string): string | null {
  const marker = JSON.stringify(key);
  const keyIndex = json.indexOf(marker);
  if (keyIndex < 0) return null;
  const colon = json.indexOf(":", keyIndex + marker.length);
  if (colon < 0) return null;
  let start = colon + 1;
  while (/\s/.test(json[start] ?? "")) start += 1;
  if (json[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < json.length; index += 1) {
    const char = json[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return json.slice(start, index + 1);
    }
  }
  return null;
}
