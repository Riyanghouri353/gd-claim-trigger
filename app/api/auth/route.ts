import { NextResponse } from 'next/server';
import { getAdminSession, isAdminConfigured, verifyAdminPassword } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

// Admin login for destructive dashboard actions (see lib/adminAuth.ts).
// POST {password} -> sets a sealed HttpOnly session cookie (7 days).
// DELETE -> clears the session (logout).
// GET -> {configured, authenticated} for UI state.
// Login attempts are rate-limited per IP (5 per 5 minutes) to slow
// brute force against the single shared password.

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60_000;

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || 'unknown';
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now >= rec.resetAt) {
    attempts.set(ip, { count: 0, resetAt: now + WINDOW_MS });
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function noteAttempt(ip: string, ok: boolean): void {
  const now = Date.now();
  const rec = attempts.get(ip) ?? { count: 0, resetAt: now + WINDOW_MS };
  if (ok) attempts.delete(ip);
  else attempts.set(ip, { count: rec.count + 1, resetAt: rec.resetAt });
}

export async function GET() {
  let authenticated = false;
  if (isAdminConfigured()) {
    try {
      authenticated = !!(await getAdminSession()).admin;
    } catch {
      authenticated = false;
    }
  }
  return NextResponse.json({ ok: true, configured: isAdminConfigured(), authenticated });
}

export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ ok: false, error: 'admin password is not configured on the server' }, { status: 503 });
  }
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return NextResponse.json({ ok: false, error: 'too many login attempts — try again in a few minutes' }, { status: 429 });
  }
  let password = '';
  try {
    password = (await req.json()).password ?? '';
  } catch {
    password = '';
  }
  if (!verifyAdminPassword(password)) {
    noteAttempt(ip, false);
    return NextResponse.json({ ok: false, error: 'wrong password' }, { status: 401 });
  }
  noteAttempt(ip, true);
  const session = await getAdminSession();
  session.admin = true;
  await session.save();
  return NextResponse.json({ ok: true, authenticated: true });
}

export async function DELETE() {
  try {
    const session = await getAdminSession();
    session.destroy();
  } catch {
    /* already logged out */
  }
  return NextResponse.json({ ok: true, authenticated: false });
}
