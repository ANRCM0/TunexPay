import { describe, expect, it } from "vitest";
import { channelDraftErrors, notificationFieldErrors } from "./settings-validation";

describe("channel settings validation", () => {
  it("requires a plugin and nonblank name", () => {
    const errors = channelDraftErrors({ plugin: "", name: "  ", channelId: "", settings: {} });
    expect(errors.plugin).toBeTruthy();
    expect(errors.name).toBeTruthy();
    expect(errors.channelId).toBeUndefined();
  });
  it("catches malformed IDs before a network request", () => {
    const errors = channelDraftErrors({ plugin: "MOCK", name: "mock", channelId: "Bad_ID", settings: {} });
    expect(errors.channelId).toContain("小写字母");
  });
  it("rejects empty/decimal/out-of-range collector numeric values", () => {
    const settings = { validSeconds: 300, amountOffsetMax: 99, pollSeconds: 10,
      overlapSeconds: 300, lagSeconds: 15, lookbackSeconds: 3600 };
    expect(channelDraftErrors({ plugin: "ALIPAY_BILL", name: "bill", channelId: "", settings })).toEqual({});
    expect(channelDraftErrors({ plugin: "ALIPAY_BILL", name: "bill", channelId: "", settings: { ...settings, pollSeconds: "" } }).pollSeconds).toBeTruthy();
    expect(channelDraftErrors({ plugin: "ALIPAY_BILL", name: "bill", channelId: "", settings: { ...settings, pollSeconds: 3.5 } }).pollSeconds).toBeTruthy();
    expect(channelDraftErrors({ plugin: "ALIPAY_BILL", name: "bill", channelId: "", settings: { ...settings, validSeconds: 99999 } }).validSeconds).toBeTruthy();
  });
});

describe("notification plugin field validation", () => {
  const fields = [
    { key: "recipient", label: "接收地址", type: "text" as const, required: true },
    { key: "port", label: "端口", type: "number" as const, required: true },
    { key: "secret", label: "密钥", type: "password" as const, secret: true, required: true },
    { key: "region", label: "地区", type: "select" as const,
      options: [{ value: "cn", label: "中国" }] },
  ];
  it("accepts configured secret without asking to type it again", () => {
    expect(notificationFieldErrors(fields, { recipient: "admin@example.com", port: 465, secretConfigured: true, region: "cn" }, {})).toEqual({});
  });
  it("prevents empty required, invalid numeric, and invalid select", () => {
    const errors = notificationFieldErrors(fields, { recipient: " ", port: NaN, region: "invalid" }, {});
    expect(errors.recipient).toBeTruthy();
    expect(errors.port).toContain("有效数字");
    expect(errors.secret).toBeTruthy();
    expect(errors.region).toContain("有效");
  });
  it("accepts explicit zero numeric values when allowed by a plugin", () => {
    expect(notificationFieldErrors([{ key: "n", label: "次数", type: "number", required: true }], { n: 0 }, {})).toEqual({});
  });
});
