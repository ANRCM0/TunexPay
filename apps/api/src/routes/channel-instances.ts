import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { pluginCatalog } from "../channels/plugins.js";
import { listChannels, saveChannel, checkChannel, loadChannel, publicChannel, assignChannel } from "../services/channel-instance-service.js";
import { createChannelTest } from "../services/channel-test-service.js";
import { alipayBillCollectorStatus } from "../services/alipay-bill-collector-service.js";
import { AppError } from "../lib/errors.js";
import { yuanToCents } from "../lib/money.js";

export const channelInstanceRoutes = new Hono<AppEnv>();
channelInstanceRoutes.get("/plugins", c => c.json({ data: pluginCatalog() }));
channelInstanceRoutes.get("/channel-instances", async c => c.json({ data: await listChannels() }));
channelInstanceRoutes.post("/channel-instances", async c => c.json({ data: await saveChannel(await c.req.json()) }, 201));
channelInstanceRoutes.get("/channel-instances/:id", async c => c.json({ data: await publicChannel(await loadChannel(c.req.param("id"))) }));
channelInstanceRoutes.post("/channel-instances/:id", async c => c.json({ data: await saveChannel(await c.req.json(), c.req.param("id")) }));
const revisionInput = z.object({ revision: z.number().int().positive() }).strict();
const testPaymentInput = z.object({ revision: z.number().int().positive(), amount: z.string().trim().max(16).optional() }).strict();
channelInstanceRoutes.post("/channel-instances/:id/check", async c => {
  const { revision } = revisionInput.parse(await c.req.json());
  return c.json({ data: await checkChannel(c.req.param("id"), revision) });
});
channelInstanceRoutes.post("/channel-instances/:id/test-payment", async c => {
  const { revision, amount } = testPaymentInput.parse(await c.req.json());
  const cents = yuanToCents(amount ?? "0.01");
  if (cents > 100_000) throw new AppError("INVALID_AMOUNT", "验收金额不能超过 1000 元", 422);
  return c.json({ data: await createChannelTest(c.req.param("id"), revision, cents) });
});
channelInstanceRoutes.get("/channel-instances/:id/collector", async c => {
  const row = await loadChannel(c.req.param("id"));
  if (row.plugin !== "ALIPAY_BILL") throw new AppError("PLUGIN_MISMATCH", "该通道没有账单采集器", 404);
  return c.json({ data: await alipayBillCollectorStatus(row.id) });
});
channelInstanceRoutes.post("/applications/:id/channel-instance", async c => {
  const { channelId } = z.object({ channelId: z.string().min(1).max(80) }).strict().parse(await c.req.json());
  return c.json({ data: await assignChannel(c.req.param("id"), channelId) });
});
