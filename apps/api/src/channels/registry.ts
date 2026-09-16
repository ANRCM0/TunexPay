import type { PaymentChannelCode } from "@prisma/client";
import { AppError } from "../lib/errors.js";
import { AlipayChannel } from "./alipay.js";
import { AlipayBillChannel } from "./alipay-bill.js";
import { MockChannel } from "./mock.js";
import type { PaymentChannel } from "./types.js";

const channels = new Map<PaymentChannelCode, PaymentChannel>([
  ["ALIPAY", new AlipayChannel()],
  ["ALIPAY_BILL", new AlipayBillChannel()],
  ["MOCK", new MockChannel()],
]);

export function channelFor(code: PaymentChannelCode): PaymentChannel {
  const channel = channels.get(code);
  if (!channel) throw new AppError("CHANNEL_NOT_FOUND", `支付通道 ${code} 不存在`, 404);
  return channel;
}
