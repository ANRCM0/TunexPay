import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { config } from "../config.js";
import { toolCatalogForAdmin } from "../mcp/tools.js";
import { approveMcpAction, listMcpActions, rejectMcpAction } from "../services/mcp-approval-service.js";
import { createMcpClient, listMcpClients, rotateMcpClientToken, setMcpClientEnabled, updateMcpClient } from "../services/mcp-client-service.js";
import { listMcpAudits } from "../services/mcp-audit-service.js";

export const mcpAdminRoutes = new Hono<AppEnv>();

mcpAdminRoutes.get("/mcp/info", c => c.json({ data: {
  enabled: config().MCP_ENABLED,
  endpoint: `${config().API_PUBLIC_URL.replace(/\/$/,"")}/mcp`,
  legacyReadTokenConfigured: Boolean(config().MCP_TOKEN),
} }));
mcpAdminRoutes.get("/mcp/tools", c => c.json({ data: toolCatalogForAdmin() }));
mcpAdminRoutes.get("/mcp/clients", async c => c.json({ data: await listMcpClients() }));
mcpAdminRoutes.post("/mcp/clients", async c => c.json({ data: await createMcpClient(await c.req.json()) }, 201));
mcpAdminRoutes.post("/mcp/clients/:id", async c => c.json({ data: await updateMcpClient(c.req.param("id"), await c.req.json()) }));
mcpAdminRoutes.post("/mcp/clients/:id/rotate", async c => c.json({ data: await rotateMcpClientToken(c.req.param("id")) }));
mcpAdminRoutes.post("/mcp/clients/:id/enabled", async c => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json());
  return c.json({ data: await setMcpClientEnabled(c.req.param("id"), enabled) });
});
mcpAdminRoutes.get("/mcp/audits", async c => c.json({ data: await listMcpAudits(c.req.query()) }));
mcpAdminRoutes.get("/mcp/approvals", async c => {
  const limit = z.coerce.number().int().min(1).max(100).default(50).parse(c.req.query("limit"));
  return c.json({ data: await listMcpActions(limit) });
});
mcpAdminRoutes.post("/mcp/approvals/:id/approve", async c => c.json({ data: await approveMcpAction(c.req.param("id"), "admin-console") }));
mcpAdminRoutes.post("/mcp/approvals/:id/reject", async c => c.json({ data: await rejectMcpAction(c.req.param("id"), "admin-console") }));
