import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import {
  createNotificationInstance, deleteNotificationInstance, getNotificationInstance, listNotificationDeliveries,
  listNotificationInstances, listNotificationPlugins, retryNotificationDelivery, saveNotificationInstance,
  setNotificationSubscriptions, testNotificationInstance,
} from "../services/notification-instance-service.js";
import { NOTIFICATION_EVENTS } from "../notifications/types.js";

export const notificationRoutes = new Hono<AppEnv>();

notificationRoutes.get("/notification-plugins", async c => c.json({ data: await listNotificationPlugins() }));
notificationRoutes.get("/notification-instances", async c => {
  const includeArchived = z.enum(["true", "false"]).optional().parse(c.req.query("includeArchived")) === "true";
  return c.json({ data: await listNotificationInstances(includeArchived) });
});
notificationRoutes.post("/notification-instances", async c => c.json({ data: await createNotificationInstance(await c.req.json()) }, 201));
notificationRoutes.get("/notification-instances/:id", async c => c.json({ data: await getNotificationInstance(c.req.param("id")) }));
notificationRoutes.post("/notification-instances/:id", async c => c.json({ data: await saveNotificationInstance(c.req.param("id"), await c.req.json()) }));
notificationRoutes.post("/notification-instances/:id/subscriptions", async c => {
  const { events } = z.object({ events: z.array(z.enum(NOTIFICATION_EVENTS)) }).parse(await c.req.json());
  return c.json({ data: await setNotificationSubscriptions(c.req.param("id"), events) });
});
notificationRoutes.post("/notification-instances/:id/test", async c => {
  const task = await testNotificationInstance(c.req.param("id"));
  return c.json({ data: { id: task.id, status: task.status } }, 202);
});
notificationRoutes.post("/notification-instances/:id/delete", async c => c.json({ data: await deleteNotificationInstance(c.req.param("id")) }));
notificationRoutes.get("/notification-deliveries", async c => c.json({ data: await listNotificationDeliveries() }));
notificationRoutes.post("/notification-deliveries/:id/retry", async c => c.json({ data: await retryNotificationDelivery(c.req.param("id")) }));
