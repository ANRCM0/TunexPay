import { NextRequest, NextResponse } from "next/server";

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
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
    return new NextResponse(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") || "application/json" } });
  } catch {
    return NextResponse.json({ error: { code: "API_UNAVAILABLE", message: "支付 API 暂时不可用" } }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
