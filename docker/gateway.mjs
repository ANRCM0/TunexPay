import http from "node:http";
import zlib from "node:zlib";

const gatewayPort = Number.parseInt(process.env.GATEWAY_PORT || "8080", 10);
const apiPort = Number.parseInt(process.env.API_INTERNAL_PORT || "3001", 10);
const webPort = Number.parseInt(process.env.WEB_INTERNAL_PORT || "3000", 10);
const host = "127.0.0.1";

/*
 * 响应压缩。
 *
 * Next 16 自己不做 gzip（静态产物和 HTML 都是原样输出），而管理台的 Arco CSS + JS
 * 未压缩合计约 1.6MB；容器里的网关是唯一代理层，不加这一步就等于每个页面首访都传全量。
 * 只压文本类内容，图片/字体等已压缩格式跳过；上游已经编码过的一律不动。
 */
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml|x-ndjson)|image\/svg\+xml)/i;
// 事件流与长轮询是逐步产出的，压缩会破坏分块到达的时机
const NEVER_COMPRESS = /^(text\/event-stream)/i;

function hasGzip(header = "") {
  // 解析 Accept-Encoding，尊重 q=0（显式拒绝）
  return header.split(",").some(entry => {
    const [name, ...params] = entry.trim().split(";");
    if (name.trim().toLowerCase() !== "gzip") return false;
    const q = params.map(part => part.trim()).find(part => part.startsWith("q="));
    return q ? Number.parseFloat(q.slice(2)) > 0 : true;
  });
}

function shouldCompress(request, upstreamResponse) {
  if (!hasGzip(request.headers["accept-encoding"])) return false;
  if (upstreamResponse.headers["content-encoding"]) return false;
  const type = upstreamResponse.headers["content-type"] || "";
  if (!COMPRESSIBLE.test(type) || NEVER_COMPRESS.test(type)) return false;
  const declared = Number.parseInt(upstreamResponse.headers["content-length"] || "", 10);
  // 太小的响应压缩后反而更大
  return !(Number.isFinite(declared) && declared < 1024);
}

const apiExactPaths = new Set(["/submit.php", "/mapi.php", "/api.php", "/health", "/mcp"]);

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

    // 压缩与否必须在 writeHead 之前定下来：响应头一旦发出，再改就会抛
    // ERR_HTTP_HEADERS_SENT（曾经就是这么把网关打挂的）。
    const gzip = shouldCompress(request, upstreamResponse) ? zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH }) : null;
    if (gzip) {
      // 压缩后长度未知，摘掉上游的 content-length，并声明正文会随 Accept-Encoding 变化
      delete headers["content-length"];
      headers["content-encoding"] = "gzip";
      headers.vary = headers.vary ? `${headers.vary}, Accept-Encoding` : "Accept-Encoding";
    }

    response.writeHead(upstreamResponse.statusCode || 502, headers);
    if (gzip) {
      // Z_SYNC_FLUSH 让长连接上已产出的一段及时发出，不必等缓冲区填满
      upstreamResponse.pipe(gzip).pipe(response);
      return;
    }
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
