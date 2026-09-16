import type { PaymentChannelCode, Prisma } from "@prisma/client";

export const legacyChannelId = (plugin: PaymentChannelCode) => `${plugin.toLowerCase().replaceAll("_", "-")}-default`;

// Null bindings belong only to the original account, never to another instance.
export function paymentChannelScope(id: string, plugin: PaymentChannelCode): Prisma.PaymentWhereInput {
  return id === legacyChannelId(plugin)
    ? { channel: plugin, AND: [{ OR: [{ channelId: id }, { channelId: null }] }] }
    : { channel: plugin, channelId: id };
}
