import { describe, expect, it } from "vitest";
import { newRefundIdempotencyKey, parseYuanToCents } from "./admin-refund";

describe("parseYuanToCents", () => {
  it("converts yuan with cents precision", () => {
    expect(parseYuanToCents("12.34")).toBe(1234);
    expect(parseYuanToCents("0.01")).toBe(1);
    expect(parseYuanToCents("100")).toBe(10_000);
    expect(parseYuanToCents("  9.9  ")).toBe(990);
  });

  it("protects against binary floating point drift", () => {
    // 0.1+0.2 类误差：逐位比较会得到 1233.9999999999998
    expect(parseYuanToCents("12.35")).toBe(1235);
    expect(parseYuanToCents("0.29")).toBe(29);
    expect(parseYuanToCents("1.15")).toBe(115);
    expect(parseYuanToCents("0.07")).toBe(7);
  });

  it("rejects anything it cannot represent exactly in integer cents", () => {
    for (const value of ["", "   ", "1.005", "1.234", "12.", ".5", "-5", "¥12.34", "1e3", "abc", "1,000", "0", "0.00", "00.00"]) {
      expect(parseYuanToCents(value), value).toBeNull();
    }
  });

  it("never returns a non-safe integer", () => {
    expect(parseYuanToCents("99999999999999")).toBeNull();
  });
});

describe("newRefundIdempotencyKey", () => {
  it("produces server-acceptable keys and never repeats one", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newRefundIdempotencyKey()));
    expect(keys.size).toBe(200);
    // 服务端 schema：^[A-Za-z0-9_-]+$，长度 8..64（拼上 "admin_" 后仍需 <= 80）
    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(key.length).toBeGreaterThanOrEqual(8);
      expect(key.length).toBeLessThanOrEqual(64);
      expect(`admin_${key}`.length).toBeLessThanOrEqual(80);
    }
  });
});
