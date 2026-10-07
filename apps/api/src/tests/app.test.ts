import { describe, expect, it } from "vitest";
import { app } from "../app.js";
import { APP_VERSION } from "../lib/version.js";

describe("api", () => {
  it("exposes health without touching the database", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    // 版本号来自唯一来源（构建注入 → 本地 Git → 兜底），断言常量而不是写死的字面量，
    // 否则每次发布都要改测试。
    expect(await response.json()).toMatchObject({ status: "ok", version: APP_VERSION });
  });

  it("returns a structured 404", async () => {
    const response = await app.request("/missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
