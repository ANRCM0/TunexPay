import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Shared table styling is intentionally centralized in the admin stylesheet.
// Protect against reintroducing wrapping in per-page action groups.
const css = readFileSync(new URL("../app/(admin)/admin.css", import.meta.url), "utf8");
const file = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), "utf8");

describe("list row layout", () => {
  it("reserves a standard row height and keeps horizontal scrolling inside the list", () => {
    expect(css).toMatch(/--list-row-height:\s*88px/);
    expect(css).toMatch(/\.list-table \.arco-table-tr\s*\{\s*height:\s*var\(--list-row-height\)/);
    expect(css).toMatch(/\.list-table \.arco-table-td\s*\{[^}]*vertical-align:\s*middle/s);
    expect(css).toMatch(/\.list-table \.arco-table-container[^}]*overflow-x:\s*auto/s);
  });

  it("enforces a non-wrapping action row, including channel and legacy tables", () => {
    expect(css).toMatch(/\.list-table \.row-actions,\s*\.list-table \.channel-actions\s*\{[^}]*flex-wrap:\s*nowrap/s);
    expect(css).toMatch(/\.list-table \.row-actions\s*>\s*\*,\s*\.list-table \.channel-actions\s*>\s*\*\s*\{[^}]*flex:\s*0 0 auto/s);
    expect(css).toMatch(/\.table-wrap \.row-actions\s*\{[^}]*overflow-x:\s*auto/s);
  });

  it.each([
    ["applications", 330],
    ["channels", 330],
    ["exceptions", 260],
    ["routing-groups", 160],
  ])("reserves a single line in %s action column", (name, width) => {
    const source = file(name);
    expect(source).toMatch(new RegExp(`dataIndex: "actions",\\s*width: ${width}`));
    expect(source).toMatch(/className="(?:row-actions|channel-actions)"/);
  });

  it("groups MCP client and approval buttons in flex rows instead of inline text", () => {
    const source = file("mcp-access");
    expect(source).toMatch(/dataIndex:"actions",width:210,[^\n]*<div className="row-actions">/);
    expect(source).toMatch(/dataIndex:"actions",width:170,[^\n]*<div className="row-actions">/);
  });
});
