import { describe, expect, it } from "vitest";
import { app } from "../app.js";

describe("api", () => {
  it("exposes health without touching the database", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", version: "0.1.0" });
  });

  it("returns a structured 404", async () => {
    const response = await app.request("/missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
