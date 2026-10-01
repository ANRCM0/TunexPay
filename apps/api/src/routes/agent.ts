import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { approveAgentAction, listAgentActions, rejectAgentAction } from "../services/agent-approval-service.js";

export const agentAdminRoutes = new Hono<AppEnv>();

agentAdminRoutes.get("/agent/approvals", async c => {
  const limit = z.coerce.number().int().min(1).max(100).default(50).parse(c.req.query("limit"));
  return c.json({ data: await listAgentActions(limit) });
});
agentAdminRoutes.post("/agent/approvals/:id/approve", async c => c.json({ data: await approveAgentAction(c.req.param("id"), "admin-console") }));
agentAdminRoutes.post("/agent/approvals/:id/reject", async c => c.json({ data: await rejectAgentAction(c.req.param("id"), "admin-console") }));
