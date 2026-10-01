export const NOTIFICATION_EVENTS = [
  "ORDER_SUCCEEDED",
  "PAYMENT_LATE_DUPLICATE",
  "RECEIPT_MISMATCH",
  "BUSINESS_WEBHOOK_DEAD",
  "COLLECTOR_FAILURE",
] as const;

export type NotificationEventType = typeof NOTIFICATION_EVENTS[number];

export type NotificationMessage = {
  event: NotificationEventType | "TEST";
  title: string;
  message: string;
  data?: Record<string, unknown>;
};

export type NotificationField = {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "select";
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
};

export type NotificationPlugin = {
  code: string;
  name: string;
  description: string;
  capabilities: string[];
  fields: NotificationField[];
  normalizeConfig(raw: unknown, previous?: Record<string, unknown>): Record<string, unknown>;
  publicConfig(config: Record<string, unknown>): Record<string, unknown>;
  send(input: NotificationMessage, config: Record<string, unknown>): Promise<void>;
};
