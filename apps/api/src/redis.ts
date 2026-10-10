import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";

let connection: Redis | undefined;
let queue: Queue | undefined;

export function monitorRedis(): Redis {
  if (!connection) connection = new Redis(config().REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

export function monitorWebhookQueue(): Queue {
  if (!queue) queue = new Queue("tuoxin-pay-webhooks", { connection: monitorRedis() });
  return queue;
}
