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
  status: PaymentStatus;
  channelTradeNo?: string;
  paidAt?: Date;
  raw: unknown;
};

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
