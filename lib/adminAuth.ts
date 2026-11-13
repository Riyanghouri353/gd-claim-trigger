// Admin auth for the claim dashboard's DESTRUCTIVE endpoints only:
// add/remove/restore wallet, manual trigger, manual fee check, vault backup.
// Reads (status, balances, history, wake, health) stay open, as before.
//
// Model: one shared admin password (ADMIN_PASSWORD env, 32+ chars, set in
// Render). The dashboard login exchanges it once for a sealed iron-session
// cookie (7 days, HttpOnly). API callers can also send it as a Bearer token.
// When ADMIN_PASSWORD is unset or too short, destructive endpoints are
// LOCKED (503/401) rather than silently open — fail closed.
//
// This mirrors the agent's iron-session pattern (lib/agent/auth.ts) with a
// separate cookie name, so the two logins never interfere.

import { getIronSession, type SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';
import { createHash, timingSafeEqual } from 'crypto';

export interface AdminSession {
  admin?: boolean;
}

export const ADMIN_COOKIE = 'claim_admin';

export function adminPassword(): string {
  return (process.env.ADMIN_PASSWORD || '').trim();
}

export function isAdminConfigured(): boolean {
  return adminPassword().length >= 32;
}

function sessionOptions(): SessionOptions {
  return {
    password: isAdminConfigured()
      ? adminPassword()
      : 'dev-only-change-me-please-32-chars-minimum!!',
    cookieName: ADMIN_COOKIE,
    cookieOptions: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    },
  };
}

export async function getAdminSession() {
  return getIronSession<AdminSession>(await cookies(), sessionOptions());
}

/** Constant-time password check (SHA-256 both sides so lengths always match). */
export function verifyAdminPassword(input: string): boolean {
  if (!isAdminConfigured()) return false;
  const a = createHash('sha256').update(adminPassword()).digest();
  const b = createHash('sha256').update((input || '').trim()).digest();
  return timingSafeEqual(a, b);
}

function bearerMatches(req: Request): boolean {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return false;
  return verifyAdminPassword(m[1]);
}

/**
 * True when the request carries a valid admin session cookie OR a valid
 * Bearer token. False (fail closed) when no admin password is configured.
 */
export async function isAdminRequest(req: Request): Promise<boolean> {
  if (!isAdminConfigured()) return false;
  if (bearerMatches(req)) return true;
  try {
    const session = await getAdminSession();
    return !!session.admin;
  } catch {
    return false;
  }
}
