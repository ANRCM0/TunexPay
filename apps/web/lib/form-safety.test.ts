import { describe, expect, it } from "vitest";
import { cashierLink, retainAllowedTools } from "./form-safety";

describe("least-privilege MCP tool selection", () => {
  it("does not select everything after initial loading", () => {
    expect(retainAllowedTools([], ["read", "write"])).toEqual([]);
  });
  it("retains only already selected tools supported by the new scope", () => {
    expect(retainAllowedTools(["read", "write"], ["read", "list", "search"])).toEqual(["read"]);
  });
  it("does not silently re-add tools after the user deliberately clears all", () => {
    expect(retainAllowedTools([], ["read"])).toEqual([]);
  });
});

describe("cashier URL validation", () => {
  it("accepts local and HTTPS payment pages", () => {
    expect(cashierLink("/cashier/PAY123", "https://example.com")).toBe("https://example.com/cashier/PAY123");
    expect(cashierLink("https://payments.example.net/p", "https://example.com")).toBe("https://payments.example.net/p");
  });
  it("rejects empty and non-web URLs", () => {
    expect(() => cashierLink("", "https://example.com")).toThrow();
    expect(() => cashierLink("javascript:alert(1)", "https://example.com")).toThrow();
    expect(() => cashierLink("data:text/html,hi", "https://example.com")).toThrow();
  });
});
