import { config } from "../config.js";
import { ChannelDefinitiveError } from "../lib/errors.js";
import type { ChannelCreateInput, ChannelCreateResult, ChannelQueryResult, ChannelRefundInput, ChannelRefundQueryInput, ChannelRefundResult, ChannelWebhookResult, PaymentChannel } from "./types.js";

export class MockChannel implements PaymentChannel {
  readonly code = "MOCK" as const;

  async create(input: ChannelCreateInput): Promise<ChannelCreateResult> {
    if (!config().MOCK_CHANNEL_ENABLED) throw new ChannelDefinitiveError("MOCK_DISABLED", "模拟支付通道未启用");
    return {
      status: "PROCESSING",
      channelOrderNo: input.paymentNo,
      clientPayload: { type: "mock", paymentNo: input.paymentNo },
      raw: { mock: true },
    };
  }

  async query(_paymentNo: string): Promise<ChannelQueryResult> {
    return { status: "PROCESSING", raw: { mock: true } };
  }

  async close(_paymentNo: string): Promise<{ closed: boolean; raw: unknown }> {
    return { closed: true, raw: { mock: true } };
  }

  async refund(input: ChannelRefundInput): Promise<ChannelRefundResult> {
    return { status: "SUCCESS", channelRefundNo: `mock_${input.refundNo}`, raw: { mock: true } };
  }

  async queryRefund(input: ChannelRefundQueryInput): Promise<ChannelRefundResult> {
    return { status: "SUCCESS", channelRefundNo: `mock_${input.refundNo}`, raw: { mock: true } };
  }

  async handleWebhook(_payload: Record<string, string>): Promise<ChannelWebhookResult> {
    throw new ChannelDefinitiveError("MOCK_WEBHOOK_UNSUPPORTED", "模拟通道不接收外部回调");
  }
}
