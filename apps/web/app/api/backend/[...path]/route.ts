import { NextRequest, NextResponse } from "next/server";

type RouteContext = { params: Promise<{ path: string[] }> };

// 只读方法不改变服务端状态，不需要来源校验；其余方法一律要求同源。
// 本文件目前只导出 GET / POST，将来若放开 PUT/PATCH/DELETE，这条规则会自动生效。
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// 可信来源 = 配置的对外前端地址 + 本次请求自身的来源。
// 生产环境经过反向代理时 request.url 可能指向内网地址，所以配置值必须参与判断；
// 未配置 WEB_PUBLIC_URL 的本地开发退化为「仅同源」，仍然拒绝跨站请求。
function trustedOrigins(request: NextRequest): Set<string> {
  const origins = new Set<string>();
  const configured = process.env.WEB_PUBLIC_URL;
  if (configured) {
    try { origins.add(new URL(configured).origin); } catch { /* 配置值不合法时只依赖同源判断 */ }
  }
  const self = new URL(request.url);
  origins.add(self.origin);
  const host = request.headers.get("host");
  if (host) origins.add(`${self.protocol}//${host}`);
  return origins;
}

// 浏览器发起的跨站写请求一定会带上 Origin，且无法被页面脚本伪造；
// 缺少 Origin 的写请求同样拒绝，避免绕过校验。
function hasTrustedOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && trustedOrigins(request).has(origin));
}

async function proxy(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  if (!READ_ONLY_METHODS.has(request.method) && !hasTrustedOrigin(request)) {
    return NextResponse.json({ error: { code: "ORIGIN_REJECTED", message: "跨站写入请求已被拒绝，请在管理台内操作" } }, { status: 403 });
  }
  const internal = process.env.INTERNAL_API_URL ?? "http://localhost:3001";
  const isPublic = path[0] === "public";
  const isMock = path[0] === "mock";
  const targetPath = isPublic || isMock
    ? `/api/v1/channels/${path.join("/")}`
    : `/admin/v1/${path.join("/")}`;
  const target = new URL(targetPath, internal);
  target.search = request.nextUrl.search;
  const headers = new Headers({ accept: request.headers.get("accept") || "application/json" });
  if (!isPublic && !isMock) headers.set("authorization", `Bearer ${process.env.ADMIN_TOKEN ?? ""}`);
  if (isMock) headers.set("x-mock-token", process.env.MOCK_CHANNEL_TOKEN ?? "");
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  try {
    const isBillImport = path.join("/") === "reconciliation/alipay/import";
    const response = await fetch(target, { method: request.method, headers, body, cache: "no-store", signal: AbortSignal.timeout(isBillImport ? 120_000 : 15_000) });
    return new NextResponse(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") || "application/json", "cache-control": "no-store, private", "referrer-policy": "no-referrer" } });
  } catch {
    return NextResponse.json({ error: { code: "API_UNAVAILABLE", message: "支付 API 暂时不可用" } }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
