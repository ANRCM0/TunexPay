import { describe, expect, it } from "vitest";
import { safeLocalRedirectPath } from "./navigation";

describe("safeLocalRedirectPath", () => {
  it("keeps normal same-origin paths including query strings", () => {
    expect(safeLocalRedirectPath("/orders/123?tab=events")).toBe("/orders/123?tab=events");
  });

  it.each([
    ["https://evil.example/path"],
    ["//evil.example/path"],
    ["/\\evil.example/path"],
    ["orders/123"],
    [""],
  ])("rejects non-local redirect target %s", (value) => {
    expect(safeLocalRedirectPath(value)).toBe("/");
  });
});
