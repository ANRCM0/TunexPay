import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigForTests } from "../config.js";
import { mcpRoutes } from "../routes/mcp.js";

const token = "mcp-test-token-000000000000000000000000";
const operateToken = "mcp-operate-token-0000000000000000000000";
const financialToken = "mcp-financial-token-00000000000000000000";

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.MCP_ENABLED = "true";
  process.env.MCP_TOKEN = token;
  process.env.MCP_OPERATE_TOKEN = operateToken;
  process.env.MCP_FINANCIAL_TOKEN = financialToken;
  resetConfigForTests();
});

afterEach(() => {
  delete process.env.MCP_ENABLED;
  delete process.env.MCP_TOKEN;
  delete process.env.MCP_OPERATE_TOKEN;
  delete process.env.MCP_FINANCIAL_TOKEN;
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

  it("negotiates initialize and advertises tools according to the bearer scope", async () => {
    const init = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(init.status).toBe(200);
    expect((await init.json()).result.capabilities).toEqual({ tools: { listChanged: false } });

    const list = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const payload = await list.json();
    expect(payload.result.tools.map((tool: { name: string }) => tool.name)).toContain("tunexpay_get_order");
    const readNames = payload.result.tools.map((tool: { name: string }) => tool.name);
    expect(readNames).not.toContain("tunexpay_retry_business_webhook");
    expect(readNames).not.toContain("tunexpay_request_refund");

    const operate = await request({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, operateToken);
    const operateNames = (await operate.json()).result.tools.map((tool: { name: string }) => tool.name);
    expect(operateNames).toContain("tunexpay_retry_business_webhook");
    expect(operateNames).not.toContain("tunexpay_request_refund");

    const financial = await request({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, financialToken);
    const financialNames = (await financial.json()).result.tools.map((tool: { name: string }) => tool.name);
    expect(financialNames).toContain("tunexpay_request_refund");
    expect(financialNames).toContain("tunexpay_request_payment_close");
  });
});
