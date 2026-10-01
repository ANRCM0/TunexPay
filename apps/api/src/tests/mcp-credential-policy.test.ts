import { describe, expect, it } from "vitest";
import { toolNamesForScope } from "../mcp/tools.js";

describe("MCP credential policy inputs", () => {
  it("has a finite explicit tool surface for every scope", () => {
    const read = new Set(toolNamesForScope("READ"));
    const operate = new Set(toolNamesForScope("OPERATE"));
    const financial = new Set(toolNamesForScope("FINANCIAL"));
    expect(read.size).toBeGreaterThan(0);
    for (const name of read) expect(operate.has(name)).toBe(true);
    for (const name of operate) expect(financial.has(name)).toBe(true);
  });
});
