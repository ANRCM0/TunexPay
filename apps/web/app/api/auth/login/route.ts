import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_SECONDS, createAdminSession } from "../../../../lib/session";

export async function POST(request: NextRequest) {
  const password = String((await request.json().catch(() => ({})) as { password?: unknown }).password ?? "");
  const expected = process.env.ADMIN_PASSWORD ?? "";
  const sessionSecret = process.env.ADMIN_SESSION_SECRET ?? "";
  if (expected.length < 12 || sessionSecret.length < 32) {
    return NextResponse.json({ error: { code: "ADMIN_AUTH_NOT_CONFIGURED", message: "管理端登录尚未配置" } }, { status: 503 });
  }
  if (!safeEqual(password, expected)) {
    return NextResponse.json({ error: { code: "INVALID_CREDENTIALS", message: "管理员口令错误" } }, { status: 401 });
  }
  const response = NextResponse.json({ data: { authenticated: true } });
  response.cookies.set(ADMIN_SESSION_COOKIE, await createAdminSession(sessionSecret), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_SESSION_TTL_SECONDS,
  });
  return response;
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
