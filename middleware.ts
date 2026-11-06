import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { unsealData } from "iron-session";

/**
 * Riyan Agent auth gate. Scoped ONLY to /agent/* and /api/agent/* —
 * the G$ claim dashboard and its APIs are intentionally untouched.
 *
 * The session seal is VALIDATED here, never just checked for presence.
 * The old presence-only check looped forever on a stale cookie: it sent
 * any cookie-holder away from /agent/login to /agent, while the page's
 * real validation sent the invalid holder back to /agent/login
 * (ERR_TOO_MANY_REDIRECTS). Now both sides judge the same seal, and a
 * cookie that fails validation is cleared on the response so the
 * browser lands on a clean login form.
 */

interface AgentSession {
  loggedIn?: boolean;
}

// Mirrors lib/agent/auth.ts (kept local: middleware cannot import the
// next/headers-based helper module).
const sealKey =
  process.env.SESSION_SECRET || "dev-only-change-me-please-32-chars-minimum!!";

const CLEAR_COOKIE =
  "agent_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" +
  (process.env.NODE_ENV === "production" ? "; Secure" : "");

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Auth API + cron carry their own checks
  if (pathname.startsWith("/api/agent/auth") || pathname.startsWith("/api/agent/cron")) {
    return NextResponse.next();
  }

  const seal = req.cookies.get("agent_session")?.value;
  const hasCookie = !!seal;
  let loggedIn = false;
  if (seal) {
    try {
      const data = await unsealData<AgentSession>(seal, { password: sealKey });
      loggedIn = !!data?.loggedIn;
    } catch {
      loggedIn = false;
    }
  }
  const staleCookie = hasCookie && !loggedIn;
  const isAuthPage = pathname === "/agent/login" || pathname === "/agent/setup";

  if (isAuthPage) {
    if (loggedIn) return NextResponse.redirect(new URL("/agent", req.url));
    const res = NextResponse.next();
    if (staleCookie) res.headers.append("set-cookie", CLEAR_COOKIE);
    return res;
  }

  if (!loggedIn) {
    if (pathname.startsWith("/api/agent/")) {
      const res = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (staleCookie) res.headers.append("set-cookie", CLEAR_COOKIE);
      return res;
    }
    const res = NextResponse.redirect(new URL("/agent/login", req.url));
    if (staleCookie) res.headers.append("set-cookie", CLEAR_COOKIE);
    return res;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/agent/:path*", "/api/agent/:path*"],
};
