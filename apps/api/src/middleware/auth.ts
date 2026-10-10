import type { MiddlewareHandler } from "hono";
import { config } from "../config.js";
import { db } from "../db.js";
import { safeEqual, sha256 } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const applicationAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKey = c.req.header("x-api-key") || c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const appId = c.req.header("x-app-id") || /^txp_(app_[a-z0-9]+)_/i.exec(apiKey)?.[1];
  if (!apiKey || !appId) throw new AppError("UNAUTHORIZED", "缺少有效的应用凭证", 401);
  const application = await db.application.findUnique({ where: { appId } });
  // 归档应用等同于已删除：即使旧 Key 还留在业务侧，也必须立刻失效。
  if (!application || application.archivedAt || application.status !== "ACTIVE" || !safeEqual(application.apiKeyHash, sha256(apiKey))) {
    throw new AppError("UNAUTHORIZED", "应用凭证无效", 401);
  }
  c.set("application", application);
  await next();
};

export const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!token || !safeEqual(token, config().ADMIN_TOKEN)) throw new AppError("UNAUTHORIZED", "管理令牌无效", 401);
  await next();
};
