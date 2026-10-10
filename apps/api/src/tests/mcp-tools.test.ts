import { describe, expect, it } from "vitest";
import { toolCatalog, toolCatalogForAdmin, toolNamesForScope } from "../mcp/tools.js";

describe("MCP tool policy", () => {
  it("keeps scope inheritance ordered", () => {
    expect(toolNamesForScope("READ")).toContain("tunexpay_get_order");
    expect(toolNamesForScope("READ")).not.toContain("tunexpay_query_payment");
    expect(toolNamesForScope("OPERATE")).toContain("tunexpay_query_payment");
    expect(toolNamesForScope("OPERATE")).not.toContain("tunexpay_request_refund");
    expect(toolNamesForScope("FINANCIAL")).toContain("tunexpay_request_refund");
  });

  it("applies a per-client allowlist after scope filtering", () => {
    const names = toolCatalog("OPERATE", ["tunexpay_get_order", "tunexpay_query_payment", "tunexpay_request_refund"]).map(tool => tool.name);
    expect(names).toEqual(["tunexpay_get_order", "tunexpay_query_payment"]);
  });

  it("exposes required scopes to the admin policy UI", () => {
    const refund = toolCatalogForAdmin().find(tool => tool.name === "tunexpay_request_refund");
    expect(refund?.scope).toBe("FINANCIAL");
  });
});
