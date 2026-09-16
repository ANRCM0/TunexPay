import { config } from "../config.js";
import { ChannelDefinitiveError } from "../lib/errors.js";
import { centsToYuan } from "../lib/money.js";
import type { ChannelCreateInput, ChannelCreateResult, ChannelQueryResult, ChannelRefundInput, ChannelRefundQueryInput, ChannelRefundResult, ChannelWebhookResult, PaymentChannel } from "./types.js";

export class AlipayBillChannel implements PaymentChannel {
  readonly code = "ALIPAY_BILL" as const;

  async create(input: ChannelCreateInput): Promise<ChannelCreateResult> {
    const cfg = config();
    if (!cfg.ALIPAY_BILL_ENABLED || !cfg.ALIPAY_BILL_QR_CONTENT) {
      throw new ChannelDefinitiveError("ALIPAY_BILL_NOT_CONFIGURED", "支付宝账单收款通道尚未配置");
    }
    return {
      status: "PROCESSING",
      channelOrderNo: input.paymentNo,
      clientPayload: {
        type: "qr_code",
        value: cfg.ALIPAY_BILL_QR_CONTENT,
        receipt: true,
        amount: centsToYuan(input.amount),
        businessAmount: centsToYuan(input.businessAmount ?? input.amount),
        remark: input.matchReference ?? null,
        validUntil: input.validUntil?.toISOString() ?? null,
      },
      raw: { receiptChannel: true, matchMode: cfg.ALIPAY_BILL_MATCH_MODE },
    };
  }

  async query(_paymentNo: string): Promise<ChannelQueryResult> {
    return { status: "PROCESSING", raw: { receiptChannel: true, waitingForWatcher: true } };
  }

  async close(_paymentNo: string): Promise<{ closed: boolean; raw: unknown }> {
    return { closed: true, raw: { receiptChannel: true } };
  }

  async refund(_input: ChannelRefundInput): Promise<ChannelRefundResult> {
    throw new ChannelDefinitiveError("ALIPAY_BILL_REFUND_MANUAL", "账单收款不支持 API 原路退款，请人工退款后处置异常单");
  }

  async queryRefund(_input: ChannelRefundQueryInput): Promise<ChannelRefundResult> {
    throw new ChannelDefinitiveError("ALIPAY_BILL_REFUND_MANUAL", "账单收款退款需要人工确认");
  }

  async handleWebhook(_payload: Record<string, string>): Promise<ChannelWebhookResult> {
    throw new ChannelDefinitiveError("ALIPAY_BILL_WEBHOOK_UNSUPPORTED", "账单收款只接受 Watcher 标准流水入口");
  }
}
