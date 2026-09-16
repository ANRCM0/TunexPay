import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  redisGet: vi.fn(),
  redisPing: vi.fn(),
  jobCounts: vi.fn(),
}));

vi.mock("../db.js", () => {
  const count = async () => 0;
  const findFirst = async () => null;
  return {
    db: {
      $queryRaw: mocks.queryRaw,
      webhookDelivery: { count, findFirst },
      payment: { count, findFirst },
      refund: { count, findFirst },
      paymentException: { count },
    },
  };
});

vi.mock("../redis.js", () => ({
  monitorRedis: () => ({ get: mocks.redisGet, ping: mocks.redisPing }),
  monitorWebhookQueue: () => ({ getJobCounts: mocks.jobCounts }),
}));

import { app } from "../app.js";

const AUTH = { Authorization: "Bearer development-admin-token-change-me" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRaw.mockResolvedValue([{ version: "8.0.36" }]);
  mocks.redisPing.mockResolvedValue("PONG");
  mocks.redisGet.mockResolvedValue(new Date().toISOString());
  mocks.jobCounts.mockResolvedValue({ waiting: 2, active: 1, delayed: 0, failed: 3 });
});

describe("GET /admin/v1/system", () => {
  it("requires the admin token", async () => {
    const response = await app.request("/admin/v1/system");
    expect(response.status).toBe(401);
  });

  it("reports every subsystem with queue counts and an online worker", async () => {
    const response = await app.request("/admin/v1/system", { headers: AUTH });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.api).toMatchObject({ version: "0.1.0", nodeEnv: process.env.NODE_ENV ?? "test" });
    expect(body.data.mysql).toMatchObject({ ok: true, version: "8.0.36" });
    expect(body.data.redis).toMatchObject({ ok: true });
    expect(body.data.worker).toMatchObject({ status: "ONLINE" });
    expect(body.data.webhookQueue).toEqual({ ok: true, waiting: 2, active: 1, delayed: 0, failed: 3 });
    expect(body.data.tasks).toMatchObject({ pendingWebhooks: 0, deadWebhooks: 0, nextTaskAt: null });
  });

  it("degrades to mysql.ok=false instead of failing the endpoint", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("ECONNREFUSED"));
    const response = await app.request("/admin/v1/system", { headers: AUTH });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.mysql).toMatchObject({ ok: false, error: "ECONNREFUSED" });
  });

  it("marks the worker offline when the heartbeat is stale or missing", async () => {
    mocks.redisGet.mockResolvedValue(new Date(Date.now() - 120_000).toISOString());
    const stale = await (await app.request("/admin/v1/system", { headers: AUTH })).json();
    expect(stale.data.worker.status).toBe("OFFLINE");

    mocks.redisGet.mockResolvedValue(null);
    const missing = await (await app.request("/admin/v1/system", { headers: AUTH })).json();
    expect(missing.data.worker.status).toBe("OFFLINE");

    mocks.redisGet.mockResolvedValue(new Date(Date.now() - 30_000).toISOString());
    const delayed = await (await app.request("/admin/v1/system", { headers: AUTH })).json();
    expect(delayed.data.worker.status).toBe("STALE");
  });
});
