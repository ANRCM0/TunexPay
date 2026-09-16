import { NextRequest, NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from "./lib/session";

const publicPrefixes = ["/cashier/", "/api/auth/", "/api/backend/public/", "/api/backend/mock/"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = pathname === "/login" || publicPrefixes.some(prefix => pathname.startsWith(prefix));
  const valid = await verifyAdminSession(request.cookies.get(ADMIN_SESSION_COOKIE)?.value, process.env.ADMIN_SESSION_SECRET ?? "");

  if (pathname === "/login" && valid) return NextResponse.redirect(new URL("/", request.url));
  if (isPublic) return NextResponse.next();
  if (valid) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: { code: "ADMIN_SESSION_REQUIRED", message: "管理会话已过期，请重新登录" } }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
