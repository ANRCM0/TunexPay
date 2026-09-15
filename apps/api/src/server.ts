import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { config } from "./config.js";
import { log } from "./lib/logger.js";

const server = serve({ fetch: app.fetch, port: config().PORT }, (info) => {
  log("info", "api.started", { port: info.port });
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
