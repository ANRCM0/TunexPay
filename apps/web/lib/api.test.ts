import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => { vi.unstubAllGlobals(); });

describe("api", () => {
  it("accepts an empty successful response without JSON parse failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api<void>("/empty")).resolves.toBeUndefined();
  });

  it("uses a useful fallback for non-JSON errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream failed", { status: 502, statusText: "Bad Gateway" })));
    await expect(api("/broken")).rejects.toThrow("Bad Gateway");
  });

  it("only sends JSON content-type when there is a request body", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api("/items");
    await api("/items", { method: "POST", body: "{}" });
    const getHeaders = fetchMock.mock.calls[0]![1]!.headers as Headers;
    const postHeaders = fetchMock.mock.calls[1]![1]!.headers as Headers;
    expect(getHeaders.has("content-type")).toBe(false);
    expect(postHeaders.get("content-type")).toBe("application/json");
  });
});
