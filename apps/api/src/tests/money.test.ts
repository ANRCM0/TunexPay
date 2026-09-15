import { describe, expect, it } from "vitest";
import { centsToYuan, yuanToCents } from "../lib/money.js";

describe("money", () => {
  it("converts decimal yuan without floating point arithmetic", () => {
    expect(yuanToCents("19.99")).toBe(1999);
    expect(yuanToCents("10")).toBe(1000);
    expect(yuanToCents("0.01")).toBe(1);
    expect(centsToYuan(1999)).toBe("19.99");
  });

  it.each(["0", "-1", "1.001", "01.00", "abc"])("rejects invalid amount %s", (value) => {
    expect(() => yuanToCents(value)).toThrow();
  });
});
