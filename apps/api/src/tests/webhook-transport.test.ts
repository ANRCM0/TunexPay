import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
// Only this isolated test module permits loopback. The transport itself is not mocked.
vi.mock("../config.js", () => ({ config: () => ({ ALLOW_PRIVATE_WEBHOOKS: true }) }));
import { sendWebhookRequest, WEBHOOK_RESPONSE_MAX_BYTES } from "../lib/webhook-security.js";

const servers: Server[] = [];
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  return { url: `http://fixture.invalid:${address.port}`, host: `fixture.invalid:${address.port}` };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  })));
});

describe("native pinned transport on an isolated loopback fixture", () => {
  it("connects using the checked address, not system DNS, and retains the original Host and body", async () => {
    let receivedHost: string | undefined;
    let receivedBody = "";
    const target = await fixture((request, response) => {
      receivedHost = request.headers.host;
      request.setEncoding("utf8");
      request.on("data", chunk => { receivedBody += chunk; });
      request.on("end", () => { response.end("success"); });
    });
    const result = await sendWebhookRequest(`${target.url}/hook?test=1`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"amount":100}' });
    expect(result).toEqual({ status: 200, body: "success" });
    expect(receivedHost).toBe(target.host);
    expect(receivedBody).toBe('{"amount":100}');
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith("fixture.invalid", { all: true, verbatim: true });
  });

  it("does not follow a redirect using the real HTTP client", async () => {
    let targetHits = 0;
    const target = await fixture((request, response) => {
      if (request.url === "/redirect") { response.writeHead(302, { location: "/target" }); response.end(); }
      else { targetHits += 1; response.end("success"); }
    });
    await expect(sendWebhookRequest(`${target.url}/redirect`, { method: "GET" })).rejects.toMatchObject({ code: "WEBHOOK_REDIRECT_BLOCKED" });
    expect(targetHits).toBe(0);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized response received from a real stream", async () => {
    const target = await fixture((_request, response) => response.end(Buffer.alloc(WEBHOOK_RESPONSE_MAX_BYTES + 1, "x")));
    await expect(sendWebhookRequest(`${target.url}/hook`, { method: "GET" })).rejects.toMatchObject({ code: "WEBHOOK_RESPONSE_TOO_LARGE" });
  });
});
