/** Shared client-side validation. The API remains the final authority. */
export const CHANNEL_NUMERIC_BOUNDS = [
  ["validSeconds", "识别有效期", 60, 3600],
  ["amountOffsetMax", "最大金额偏移", 0, 99],
  ["pollSeconds", "采集间隔", 3, 3600],
  ["overlapSeconds", "重叠补拉", 60, 3600],
  ["lagSeconds", "采集延迟", 2, 300],
  ["lookbackSeconds", "首次回看", 300, 86400],
] as const;

export function channelDraftErrors(input: {
  plugin: string;
  name: string;
  channelId: string;
  settings: Record<string, string | number | boolean>;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.plugin) errors.plugin = "请选择支付插件";
  if (!input.name.trim()) errors.name = "请填写通道名称";
  if (input.channelId.trim() && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.channelId.trim())) {
    errors.channelId = "只能使用小写字母、数字和中划线，且不能以中划线开头或结尾";
  }
  if (input.plugin === "ALIPAY_BILL") {
    for (const [key, label, min, max] of CHANNEL_NUMERIC_BOUNDS) {
      const value = input.settings[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        errors[key] = `${label}必须是 ${min} 到 ${max} 之间的整数`;
      }
    }
  }
  return errors;
}

/** A plugin field may have been configured earlier, or the user may be replacing its secret now. */
export type ConfigField = {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "select";
  required?: boolean;
  secret?: boolean;
  options?: Array<{ value: string; label: string }>;
};

export function notificationFieldErrors(
  fields: ConfigField[],
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const raw = field.secret ? secrets[field.key] : config[field.key];
    const configured = field.secret && Boolean(config[`${field.key}Configured`]);
    const empty = raw === null || raw === undefined || String(raw).trim() === "";
    if (field.required && empty && !configured) {
      errors[field.key] = `请填写「${field.label}」`;
      continue;
    }
    if (empty) continue;
    if (field.type === "number" && (typeof raw !== "number" || !Number.isFinite(raw))) {
      errors[field.key] = `「${field.label}」必须是有效数字`;
    }
    if (field.type === "select" && field.options?.length &&
      !field.options.some(option => option.value === String(raw))) {
      errors[field.key] = `请选择有效的「${field.label}」`;
    }
  }
  return errors;
}
