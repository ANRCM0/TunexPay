import type { PaymentChannelCode, PaymentStatus, RefundStatus } from "@prisma/client";

export type ChannelCreateInput = {
  paymentNo: string;
  amount: number;
  subject: string;
  description?: string | null;
  notifyUrl: string;
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

export type ChannelWebhookResult = {
  eventKey: string;
  paymentNo: string;
  status: PaymentStatus;
  amount: number;
  channelTradeNo?: string;
  paidAt?: Date;
  raw: Record<string, string>;
};

export interface PaymentChannel {
  readonly code: PaymentChannelCode;
  create(input: ChannelCreateInput): Promise<ChannelCreateResult>;
  query(paymentNo: string): Promise<ChannelQueryResult>;
  close(paymentNo: string): Promise<{ closed: boolean; raw: unknown }>;
  refund(input: ChannelRefundInput): Promise<ChannelRefundResult>;
  handleWebhook(payload: Record<string, string>): Promise<ChannelWebhookResult>;
}
