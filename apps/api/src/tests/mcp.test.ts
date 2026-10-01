import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigForTests } from "../config.js";
import { mcpRoutes } from "../routes/mcp.js";

const token = "mcp-test-token-000000000000000000000000";

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.MCP_ENABLED = "true";
  process.env.MCP_TOKEN = token;
  resetConfigForTests();
});

afterEach(() => {
  delete process.env.MCP_ENABLED;
  delete process.env.MCP_TOKEN;
  resetConfigForTests();
});

function request(body: unknown, bearer = token) {
  return mcpRoutes.request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

describe("MCP endpoint", () => {
  it("requires its dedicated bearer token", async () => {
    const response = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "wrong-token");
    expect(response.status).toBe(401);
  });

  it("negotiates initialize and advertises read-only tools", async () => {
    const init = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(init.status).toBe(200);
    expect((await init.json()).result.capabilities).toEqual({ tools: { listChanged: false } });

    const list = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const payload = await list.json();
    expect(payload.result.tools.map((tool: { name: string }) => tool.name)).toContain("tunexpay_get_order");
    expect(payload.result.tools.map((tool: { name: string }) => tool.name).some((name: string) => /refund.*create|close|update|delete/i.test(name))).toBe(false);
  });
});
