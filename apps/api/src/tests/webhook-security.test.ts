import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), httpRequest: vi.fn(), httpsRequest: vi.fn(), allowPrivate: false }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ request: mocks.httpRequest }));
vi.mock("node:https", () => ({ request: mocks.httpsRequest }));
vi.mock("../config.js", () => ({ config: () => ({ ALLOW_PRIVATE_WEBHOOKS: mocks.allowPrivate }) }));

import { isPrivateAddress, sendWebhookRequest, WEBHOOK_RESPONSE_MAX_BYTES, WEBHOOK_TIMEOUT_MS } from "../lib/webhook-security.js";

function transport(status = 200, respond: (response: EventEmitter) => void = response => {
  response.emit("data", Buffer.from("success"));
  response.emit("end");
}) {
  const response = Object.assign(new EventEmitter(), { statusCode: status, destroy: vi.fn() });
  const request = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
  const factory = vi.fn((_options, callback) => {
    request.end.mockImplementation(() => { callback(response); respond(response); });
    return request;
  });
  mocks.httpsRequest.mockImplementation(factory);
  mocks.httpRequest.mockImplementation(factory);
  return { response, request, factory };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.allowPrivate = false;
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});
afterEach(() => vi.useRealTimers());

const blocked = [
  "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1",
  "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1",
  "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.1",
  "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  "::", "::1", "0:0:0:0:0:0:0:1", "fc00::1", "FD00::1", "fe80::1", "febf::1", "fec0::1", "ff02::1",
  "::ffff:10.0.0.1", "::ffff:a00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:c0a8:101",
  "::ffff:192.0.2.1", "64:ff9b::a00:1", "64:ff9b:1::1", "100::1", "2001::1",
  "2001:2::1", "2001:20::1", "2001:db8::1", "2002:7f00:1::1", "3fff::1", "3fff:fff::1",
  "fe80::1%eth0", "::1%lo", "2001:4860::1%eth0", "", "localhost", "not-an-ip",
];

describe("public address policy", () => {
  it.each(blocked)("blocks private/reserved/invalid address %s", address => {
    expect(isPrivateAddress(address)).toBe(true);
  });
  it.each(["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "198.17.255.255", "198.20.0.1", "2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808"])("allows public address %s", address => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe("webhook URL validation", () => {
  it.each(["http://example.com/", "ftp://example.com/", "file:///etc/passwd", "not-a-url", "https://user@example.com/", "https://user:password@example.com/"])("rejects unsafe URL %s before connecting", async url => {
    await expect(sendWebhookRequest(url, { method: "GET" })).rejects.toMatchObject({ code: "WEBHOOK_URL_BLOCKED" });
    expect(mocks.httpRequest).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it.each(["https://127.0.0.1/", "https://0x7f000001/", "https://[::ffff:a00:1]/", "https://[fe80::1]/"])("rejects normalized private literal %s", async url => {
    await expect(sendWebhookRequest(url, { method: "GET" })).rejects.toMatchObject({ code: "WEBHOOK_URL_BLOCKED" });
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("rejects a DNS result containing both public and private addresses", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "::ffff:a00:1", family: 6 }]);
    await expect(sendWebhookRequest("https://example.com/", { method: "GET" })).rejects.toMatchObject({ code: "WEBHOOK_URL_BLOCKED" });
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });
  it.each([{ addresses: [] }, { addresses: [{ address: "invalid", family: 4 }] }])("rejects empty or invalid resolver output", async ({ addresses }) => {
    mocks.lookup.mockResolvedValue(addresses);
    await expect(sendWebhookRequest("https://example.com/", { method: "GET" })).rejects.toMatchObject({ code: "WEBHOOK_URL_BLOCKED" });
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });
  it("permits explicit local HTTP without disabling credential or protocol checks", async () => {
    mocks.allowPrivate = true;
    const fixture = transport();
    expect(await sendWebhookRequest("http://127.0.0.1:8080/hook", { method: "POST", body: "hello" })).toEqual({ status: 200, body: "success" });
    expect(mocks.httpRequest).toHaveBeenCalledTimes(1);
    expect(fixture.factory.mock.calls[0]![0]).toMatchObject({ hostname: "127.0.0.1", port: "8080", headers: { host: "127.0.0.1:8080" } });
    await expect(sendWebhookRequest("http://user:password@127.0.0.1/", { method: "GET" })).rejects.toMatchObject({ code: "WEBHOOK_URL_BLOCKED" });
    await expect(sendWebhookRequest("file:///etc/passwd", { method: "GET" })).rejects.toMatchObject({ code: "WEBHOOK_URL_BLOCKED" });
  });
});

describe("pinned webhook transport", () => {
  it("pins the checked address and preserves hostname, Host, SNI and TLS verification", async () => {
    const fixture = transport();
    expect(await sendWebhookRequest("https://example.com:8443/hook?test=1", { method: "POST", headers: { host: "attacker.invalid", "content-type": "application/json" }, body: "{}" })).toEqual({ status: 200, body: "success" });
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith("example.com", { all: true, verbatim: true });
    const options = fixture.factory.mock.calls[0]![0];
    expect(options).toMatchObject({ hostname: "example.com", servername: "example.com", rejectUnauthorized: true, agent: false, family: 4, port: "8443", path: "/hook?test=1", method: "POST", headers: { host: "example.com:8443", "content-type": "application/json" } });
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const scalarCallback = vi.fn();
    options.lookup("example.com", {}, scalarCallback);
    expect(scalarCallback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    const allCallback = vi.fn();
    options.lookup("example.com", { all: true }, allCallback);
    expect(allCallback).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(fixture.request.end).toHaveBeenCalledWith("{}");
  });
  it("pins an IPv6 resolver result without turning off TLS validation", async () => {
    mocks.lookup.mockResolvedValue([{ address: "2606:4700:4700::1111", family: 6 }]);
    const fixture = transport();
    await sendWebhookRequest("https://example.com/hook", { method: "GET" });
    const options = fixture.factory.mock.calls[0]![0];
    const callback = vi.fn();
    options.lookup("example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "2606:4700:4700::1111", 6);
    expect(options.servername).toBe("example.com");
    expect(options.rejectUnauthorized).toBe(true);
  });
  it("handles public IPv6 literals without passing brackets to socket DNS", async () => {
    const fixture = transport();
    await sendWebhookRequest("https://[2606:4700:4700::1111]/hook", { method: "GET" });
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(fixture.factory.mock.calls[0]![0]).toMatchObject({ hostname: "2606:4700:4700::1111", headers: { host: "[2606:4700:4700::1111]" }, rejectUnauthorized: true });
  });
  it.each([301, 302, 307, 308])("rejects redirect %s without making a second request", async status => {
    const fixture = transport(status);
    await expect(sendWebhookRequest("https://example.com/hook", { method: "GET" })).rejects.toMatchObject({ code: "WEBHOOK_REDIRECT_BLOCKED" });
    expect(mocks.httpsRequest).toHaveBeenCalledTimes(1);
    expect(fixture.response.destroy).toHaveBeenCalled();
    expect(fixture.request.destroy).toHaveBeenCalled();
  });
  it("rejects an oversized streamed body and closes both streams", async () => {
    const fixture = transport(200, response => {
      response.emit("data", Buffer.alloc(WEBHOOK_RESPONSE_MAX_BYTES));
      response.emit("data", Buffer.from("x"));
      response.emit("end");
    });
    await expect(sendWebhookRequest("https://example.com/hook", { method: "GET" })).rejects.toMatchObject({ code: "WEBHOOK_RESPONSE_TOO_LARGE" });
    expect(fixture.response.destroy).toHaveBeenCalled();
    expect(fixture.request.destroy).toHaveBeenCalled();
  });
  it("accepts exactly the response limit and decodes split UTF-8 correctly", async () => {
    transport(200, response => {
      const content = Buffer.concat([Buffer.from("支付"), Buffer.alloc(WEBHOOK_RESPONSE_MAX_BYTES - 6, 32)]);
      response.emit("data", content.subarray(0, 2));
      response.emit("data", content.subarray(2));
      response.emit("end");
    });
    expect((await sendWebhookRequest("https://example.com/hook", { method: "GET" })).body.startsWith("支付")).toBe(true);
  });
  it("times out DNS and never connects when the late result arrives", async () => {
    vi.useFakeTimers();
    let resolveDns!: (value: Array<{ address: string; family: number }>) => void;
    mocks.lookup.mockImplementation(() => new Promise(resolve => { resolveDns = resolve; }));
    const promise = sendWebhookRequest("https://example.com/hook", { method: "GET" });
    const assertion = expect(promise).rejects.toMatchObject({ code: "WEBHOOK_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
    await assertion;
    resolveDns([{ address: "8.8.8.8", family: 4 }]);
    await vi.runAllTimersAsync();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });
  it("times out connection/TLS or a server that never sends response headers", async () => {
    vi.useFakeTimers();
    const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    mocks.httpsRequest.mockReturnValue(request);
    const assertion = expect(sendWebhookRequest("https://example.com/hook", { method: "GET" })).rejects.toMatchObject({ code: "WEBHOOK_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
    await assertion;
    expect(request.end).toHaveBeenCalledOnce();
    expect(request.destroy).toHaveBeenCalledOnce();
  });
  it("does not make a connection after DNS resolution fails", async () => {
    mocks.lookup.mockRejectedValue(new Error("getaddrinfo ENOTFOUND example.com"));
    await expect(sendWebhookRequest("https://example.com/hook", { method: "GET" })).rejects.toThrow("ENOTFOUND");
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });
  it("pins explicitly allowed private DNS results instead of reverting to normal lookup", async () => {
    mocks.allowPrivate = true;
    mocks.lookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    const fixture = transport();
    await sendWebhookRequest("http://internal.example/hook", { method: "POST", body: "{}" });
    const options = fixture.factory.mock.calls[0]![0];
    const callback = vi.fn();
    options.lookup("internal.example", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "10.0.0.1", 4);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it("keeps the deadline active while receiving an incomplete body", async () => {
    vi.useFakeTimers();
    const fixture = transport(200, response => response.emit("data", Buffer.from("incomplete")));
    const promise = sendWebhookRequest("https://example.com/hook", { method: "GET" });
    const assertion = expect(promise).rejects.toMatchObject({ code: "WEBHOOK_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
    await assertion;
    expect(fixture.response.destroy).toHaveBeenCalled();
    expect(fixture.request.destroy).toHaveBeenCalled();
  });
  it("rejects aborted responses rather than accepting partial ACKs", async () => {
    transport(200, response => { response.emit("data", Buffer.from("suc")); response.emit("aborted"); });
    await expect(sendWebhookRequest("https://example.com/hook", { method: "GET" })).rejects.toMatchObject({ code: "WEBHOOK_RESPONSE_ABORTED" });
  });
  it("propagates TLS/connection errors without disabling certificate verification", async () => {
    const fixture = transport(200, () => {});
    mocks.httpsRequest.mockImplementation((_options, _callback) => {
      fixture.request.end.mockImplementation(() => fixture.request.emit("error", new Error("certificate expired")));
      return fixture.request;
    });
    await expect(sendWebhookRequest("https://example.com/hook", { method: "GET" })).rejects.toThrow("certificate expired");
    expect(fixture.request.destroy).toHaveBeenCalled();
  });
});
