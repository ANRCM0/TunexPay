import type { PaymentChannelCode, PaymentStatus, Prisma, RefundStatus } from "@prisma/client";

export type ChannelCreateInput = {
  paymentNo: string;
  amount: number;
  businessAmount?: number;
  subject: string;
  description?: string | null;
  notifyUrl: string;
  matchReference?: string | null;
  validUntil?: Date | null;
};

export type ChannelCreateResult = {
  status: PaymentStatus;
  channelOrderNo?: string;
  channelTradeNo?: string;
  clientPayload: Record<string, unknown>;
  raw: unknown;
};

export type ChannelQueryResult = {
  channelTradeNo?: string;
  paidAt?: Date;
  raw: unknown;
} & (
  // 成功查单必须携带通道实际金额，不能由下游用本地应付金额代填。
  | { status: "SUCCESS"; amount: number }
  | { status: Exclude<PaymentStatus, "SUCCESS"> }
);

export type ChannelRefundInput = {
  paymentNo: string;
  refundNo: string;
  channelTradeNo?: string | null;
  amount: number;
  reason?: string | null;
};

export type ChannelRefundResult = {
  status: RefundStatus;
  channelRefundNo?: string;
  raw: unknown;
};

export type ChannelRefundQueryInput = {
  paymentNo: string;
  refundNo: string;
  channelTradeNo?: string | null;
};

export type ChannelWebhookResult = {
  eventKey: string;
  paymentNo: string;
  status: PaymentStatus;
  amount: number;
  receivedAmount?: number;
  channelTradeNo?: string;
  paidAt?: Date;
  raw: Prisma.InputJsonValue;
};

export interface PaymentChannel {
  readonly code: PaymentChannelCode;
  create(input: ChannelCreateInput): Promise<ChannelCreateResult>;
  query(paymentNo: string): Promise<ChannelQueryResult>;
  close(paymentNo: string): Promise<{ closed: boolean; raw: unknown }>;
  refund(input: ChannelRefundInput): Promise<ChannelRefundResult>;
  queryRefund(input: ChannelRefundQueryInput): Promise<ChannelRefundResult>;
  handleWebhook(payload: Record<string, string>): Promise<ChannelWebhookResult>;
}
