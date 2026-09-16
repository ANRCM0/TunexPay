import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE } from "../../../../lib/session";

export async function POST() {
  const response = NextResponse.json({ data: { authenticated: false } });
  response.cookies.set(ADMIN_SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
  return response;
}
