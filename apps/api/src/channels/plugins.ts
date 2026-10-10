import type { PaymentChannelCode } from "@prisma/client";
import { AlipayChannel } from "./alipay.js";
import { AlipayBillChannel } from "./alipay-bill.js";
import { MockChannel } from "./mock.js";
import type { Config } from "../config.js";
import type { PaymentChannel } from "./types.js";

type Plugin = {
  code: PaymentChannelCode;
  name: string;
  description: string;
  capabilities: string[];
  create: (id: string, config: Config) => PaymentChannel;
};

export const paymentPlugins: Record<PaymentChannelCode, Plugin> = {
  ALIPAY: { code: "ALIPAY", name: "支付宝当面付", description: "官方接口收款，支持查单、关闭和原路退款。", capabilities: ["扫码支付", "主动查单", "原路退款", "RSA2 验签"], create: (_id, cfg) => new AlipayChannel(cfg) },
  ALIPAY_BILL: { code: "ALIPAY_BILL", name: "支付宝账单收款", description: "个人收款码与到账流水匹配，每个通道独立采集。", capabilities: ["收款码", "备注 / 金额匹配", "内置采集", "外部 Watcher"], create: (id, cfg) => new AlipayBillChannel(id, cfg) },
  MOCK: { code: "MOCK", name: "Mock 模拟支付", description: "开发验收使用，不代表真实收款能力。", capabilities: ["模拟付款", "模拟退款"], create: () => new MockChannel() },
};

export const pluginCatalog = () => Object.values(paymentPlugins).map(({ create: _create, ...info }) => info);
