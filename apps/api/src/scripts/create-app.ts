import { createApplication } from "../services/application-service.js";
import { db } from "../db.js";

const args = process.argv.slice(2);
const value = (name: string) => args[args.indexOf(name) + 1];
const name = value("--name");
if (!name) {
  console.error("Usage: npm run app:create -- --name 'TUOXIN Matrix' [--webhook https://example.com/webhook] [--channel ALIPAY|MOCK]");
  process.exit(1);
}

try {
  const result = await createApplication({
    name,
    webhookUrl: value("--webhook") || null,
    defaultChannel: value("--channel") === "ALIPAY" ? "ALIPAY" : "MOCK",
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db.$disconnect();
}
