import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";

export interface AgentSession {
  loggedIn?: boolean;
}

const sessionOptions: SessionOptions = {
  password:
    process.env.SESSION_SECRET ||
    "dev-only-change-me-please-32-chars-minimum!!",
  cookieName: "agent_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  },
};

export async function getSession() {
  return getIronSession<AgentSession>(await cookies(), sessionOptions);
}

/** Throws Response with 401 when not logged in — use in API routes. */
export async function requireSession() {
  const session = await getSession();
  if (!session.loggedIn) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return session;
}
