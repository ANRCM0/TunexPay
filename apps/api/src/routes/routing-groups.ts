import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { assignRoutingGroup, deleteRoutingGroup, listRoutingGroups, saveRoutingGroup } from "../services/routing-group-service.js";

export const routingGroupRoutes = new Hono<AppEnv>();
routingGroupRoutes.get("/routing-groups", async c => c.json({ data: await listRoutingGroups() }));
routingGroupRoutes.post("/routing-groups", async c => c.json({ data: await saveRoutingGroup(await c.req.json()) }, 201));
routingGroupRoutes.post("/routing-groups/:id", async c => c.json({ data: await saveRoutingGroup(await c.req.json(), c.req.param("id")) }));
routingGroupRoutes.post("/routing-groups/:id/delete", async c => {
  const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(await c.req.json());
  return c.json({ data: await deleteRoutingGroup(c.req.param("id"), revision) });
});
routingGroupRoutes.post("/applications/:id/routing-group", async c => {
  const { groupId } = z.object({ groupId: z.string().trim().min(1).max(80).nullable() }).strict().parse(await c.req.json());
  return c.json({ data: await assignRoutingGroup(c.req.param("id"), groupId) });
});
