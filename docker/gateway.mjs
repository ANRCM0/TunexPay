import http from "node:http";

const gatewayPort = Number.parseInt(process.env.GATEWAY_PORT || "8080", 10);
const apiPort = Number.parseInt(process.env.API_INTERNAL_PORT || "3001", 10);
const webPort = Number.parseInt(process.env.WEB_INTERNAL_PORT || "3000", 10);
const host = "127.0.0.1";

const apiExactPaths = new Set(["/submit.php", "/mapi.php", "/api.php", "/health"]);

function targetFor(url = "/") {
  const pathname = new URL(url, "http://localhost").pathname;
  if (
    apiExactPaths.has(pathname) ||
    pathname === "/api/v1" ||
    pathname.startsWith("/api/v1/") ||
    pathname === "/admin/v1" ||
    pathname.startsWith("/admin/v1/")
  ) {
    return { name: "api", port: apiPort };
  }
  return { name: "web", port: webPort };
}

function forwardedHeaders(request) {
  const headers = { ...request.headers };
  delete headers.connection;
  delete headers["proxy-connection"];
  delete headers.upgrade;

  const remoteAddress = request.socket.remoteAddress;
  if (remoteAddress) {
    const existing = request.headers["x-forwarded-for"];
    headers["x-forwarded-for"] = existing ? `${existing}, ${remoteAddress}` : remoteAddress;
  }
  if (!headers["x-forwarded-host"] && request.headers.host) {
    headers["x-forwarded-host"] = request.headers.host;
  }
  if (!headers["x-forwarded-proto"]) {
    headers["x-forwarded-proto"] = "http";
  }
  return headers;
}

const server = http.createServer((request, response) => {
  const target = targetFor(request.url);
  const upstream = http.request({
    host,
    port: target.port,
    method: request.method,
    path: request.url,
    headers: forwardedHeaders(request),
  }, (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers };
    delete headers.connection;
    delete headers["keep-alive"];
    delete headers["proxy-authenticate"];
    delete headers["proxy-authorization"];
    delete headers.te;
    delete headers.trailer;
    delete headers["transfer-encoding"];
    delete headers.upgrade;

    response.writeHead(upstreamResponse.statusCode || 502, headers);
    upstreamResponse.pipe(response);
  });

  upstream.setTimeout(30_000, () => {
    upstream.destroy(new Error(`${target.name} upstream timeout`));
  });

  upstream.on("error", (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: `TunexPay ${target.name} service is temporarily unavailable`,
      },
    }));
  });

  request.pipe(upstream);
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 120_000;

server.listen(gatewayPort, "0.0.0.0", () => {
  console.log(JSON.stringify({
    level: "info",
    event: "gateway.started",
    port: gatewayPort,
    api: `http://${host}:${apiPort}`,
    web: `http://${host}:${webPort}`,
  }));
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
