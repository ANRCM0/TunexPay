// 界面展示字典：把后端枚举码翻译成中文，避免把 CODE 裸露给使用者。
// 约定：每个翻译函数都在未收录取值时回退为原始码，保证后端新增枚举时不会渲染成空白。

export type EventTone = "ok" | "warn" | "bad" | "neutral";

export const EVENT_LABELS: Record<string, string> = {
  ORDER_CREATED: "订单已创建",
  ORDER_SUCCEEDED: "订单支付成功",
  ORDER_EXPIRED: "订单过期已关闭",
  ORDER_EXPIRATION_FAILED: "订单过期处理失败",
  PAYMENT_CREATED: "支付单已创建",
  PAYMENT_PROCESSING: "支付处理中",
  PAYMENT_SUCCESS: "支付成功",
  PAYMENT_SUCCEEDED: "支付成功",
  PAYMENT_FAILED: "支付失败",
  PAYMENT_UNKNOWN: "支付结果未知",
  PAYMENT_CLOSED: "支付已关闭",
  PAYMENT_LATE_DUPLICATE: "晚到重复支付",
  PAYMENT_RECOVERY_EXHAUSTED: "支付查单已达上限",
  PAYMENT_RECOVERY_QUERY_FAILED: "支付查单失败",
  CHANNEL_CREATE_REQUESTED: "已请求通道下单",
  CHANNEL_REFUND_REQUESTED: "已请求通道退款",
  REFUND_CREATED: "退款单已创建",
  REFUND_PROCESSING: "退款处理中",
  REFUND_SUCCESS: "退款成功",
  REFUND_SUCCEEDED: "退款成功",
  REFUND_FAILED: "退款失败",
  REFUND_UNKNOWN: "退款结果未知",
  REFUND_RECOVERY_EXHAUSTED: "退款查单已达上限",
  REFUND_RECOVERY_QUERY_FAILED: "退款查单失败",
  RECEIPT_MATCHED: "流水匹配成功",
  RECEIPT_MISMATCH: "流水匹配差错",
  PAYMENT_EXCEPTION_OPENED: "登记支付异常",
  PAYMENT_EXCEPTION_PROCESSING: "异常处理中",
  PAYMENT_EXCEPTION_RESOLVED: "异常已解决",
  PAYMENT_EXCEPTION_IGNORED: "异常已忽略",
  BUSINESS_WEBHOOK_DELIVERED: "业务回调投递成功",
  BUSINESS_WEBHOOK_DEAD: "业务回调投递耗尽",
};

const EVENT_TONES: Record<string, EventTone> = {
  ORDER_SUCCEEDED: "ok",
  PAYMENT_SUCCESS: "ok",
  PAYMENT_SUCCEEDED: "ok",
  REFUND_SUCCESS: "ok",
  REFUND_SUCCEEDED: "ok",
  RECEIPT_MATCHED: "ok",
  PAYMENT_EXCEPTION_RESOLVED: "ok",
  BUSINESS_WEBHOOK_DELIVERED: "ok",
  PAYMENT_UNKNOWN: "warn",
  REFUND_UNKNOWN: "warn",
  PAYMENT_LATE_DUPLICATE: "warn",
  PAYMENT_EXCEPTION_OPENED: "warn",
  PAYMENT_EXCEPTION_PROCESSING: "warn",
  PAYMENT_RECOVERY_QUERY_FAILED: "warn",
  REFUND_RECOVERY_QUERY_FAILED: "warn",
  PAYMENT_FAILED: "bad",
  REFUND_FAILED: "bad",
  RECEIPT_MISMATCH: "bad",
  ORDER_EXPIRATION_FAILED: "bad",
  PAYMENT_RECOVERY_EXHAUSTED: "bad",
  REFUND_RECOVERY_EXHAUSTED: "bad",
  BUSINESS_WEBHOOK_DEAD: "bad",
};

export const EVENT_SOURCE_LABELS: Record<string, string> = {
  API: "业务接口",
  WORKER: "后台任务",
  ADMIN: "人工操作",
  REFUND: "退款流程",
  ALIPAY_BILL: "支付宝账单",
  ALIPAY_BILL_WATCHER: "账单采集",
};

export const PROTOCOL_LABELS: Record<string, string> = {
  NATIVE_V1: "自有协议 v1",
  EPAY_V1: "ePay 兼容 v1",
};

export const NOTIFICATION_CHANNEL_LABELS: Record<string, string> = {
  EMAIL: "邮件",
  FEISHU: "飞书",
};

export const EXCEPTION_TYPE_LABELS: Record<string, string> = {
  LATE_DUPLICATE: "晚到 / 重复支付",
  RECEIPT_AMBIGUOUS: "流水匹配多候选",
  PAYMENT_STATE_CONFLICT: "支付状态冲突",
};

export const EXCEPTION_SEVERITY_LABELS: Record<string, string> = {
  MEDIUM: "中风险",
  HIGH: "高风险",
  CRITICAL: "严重",
};

export const RECEIPT_MATCH_MODE_LABELS: Record<string, string> = {
  DIRECT: "按支付单号匹配",
  REMARK: "按备注匹配",
  AMOUNT: "按金额匹配",
};

export const CHANNEL_LABELS: Record<string, string> = {
  ALIPAY: "支付宝",
  ALIPAY_BILL: "支付宝账单",
  MOCK: "模拟通道",
};

// 业务回调对外的事件名是接口契约的一部分，保留原始字符串同时补中文说明。
export const WEBHOOK_EVENT_LABELS: Record<string, string> = {
  "payment.succeeded": "支付成功通知",
  "refund.succeeded": "退款成功通知",
};

// 管理操作审计的动作码，取值与 apps/api/src/middleware/admin-audit.ts 的 descriptor 一一对应。
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  APPLICATION_CREATE: "创建应用",
  APPLICATION_API_KEY_ROTATE: "轮换 API Key",
  APPLICATION_CREDENTIAL_ROTATE: "重置应用凭证",
  APPLICATION_STATUS_UPDATE: "启用 / 停用应用",
  APPLICATION_DELETE: "删除应用",
  APPLICATION_ARCHIVE: "归档删除应用",
  APPLICATION_RESTORE: "还原归档应用",
  APPLICATION_CHANNEL_CHANGE: "切换默认渠道",
  ALIPAY_CONNECTION_CHECK: "检查支付宝连接",
  PAYMENT_QUERY: "支付主动查单",
  PAYMENT_CLOSE: "关闭支付单",
  REFUND_QUERY: "退款主动查单",
  WEBHOOK_RETRY: "重试 Webhook 投递",
  ALIPAY_BILL_IMPORT: "导入支付宝账单",
  RECEIPT_REMATCH: "重新匹配账单",
  PAYMENT_EXCEPTION_UPDATE: "更新支付异常",
};

function pick(dictionary: Record<string, string>, value: string | null | undefined): string {
  if (!value) return "—";
  return dictionary[value] ?? value;
}

export function eventLabel(type: string): string { return pick(EVENT_LABELS, type); }
export function eventTone(type: string): EventTone { return EVENT_TONES[type] ?? "neutral"; }
export function eventSourceLabel(source: string): string { return pick(EVENT_SOURCE_LABELS, source); }
export function protocolLabel(protocol: string | null | undefined): string { return pick(PROTOCOL_LABELS, protocol); }
export function notificationChannelLabel(channel: string): string { return pick(NOTIFICATION_CHANNEL_LABELS, channel); }
export function exceptionTypeLabel(type: string): string { return pick(EXCEPTION_TYPE_LABELS, type); }
export function exceptionSeverityLabel(severity: string): string { return pick(EXCEPTION_SEVERITY_LABELS, severity); }
export function receiptMatchModeLabel(mode: string | null | undefined): string { return pick(RECEIPT_MATCH_MODE_LABELS, mode); }
export function webhookEventLabel(eventType: string): string { return pick(WEBHOOK_EVENT_LABELS, eventType); }
export function channelLabel(code: string): string { return pick(CHANNEL_LABELS, code); }
export function auditActionLabel(action: string): string { return pick(AUDIT_ACTION_LABELS, action); }
