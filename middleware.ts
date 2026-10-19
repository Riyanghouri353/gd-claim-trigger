import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Riyan Agent auth gate. Scoped ONLY to /agent/* and /api/agent/* —
 * the G$ claim dashboard and its APIs are intentionally untouched.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = req.cookies.has("agent_session");

  // Auth API + cron carry their own checks
  if (pathname.startsWith("/api/agent/auth") || pathname.startsWith("/api/agent/cron")) {
    return NextResponse.next();
  }

  if (pathname === "/agent/login" || pathname === "/agent/setup") {
    if (hasSession) return NextResponse.redirect(new URL("/agent", req.url));
    return NextResponse.next();
  }

  if (!hasSession) {
    return NextResponse.redirect(new URL("/agent/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/agent/:path*", "/api/agent/:path*"],
};
