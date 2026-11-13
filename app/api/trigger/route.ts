import { NextResponse } from 'next/server';
import { dueSlots } from '@/lib/claim';
import { isRunning, runAllWallets } from '@/lib/runner';
import { isAdminConfigured, isAdminRequest } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

// Manual immediate run (dashboard button). Admin-only: starting claims on
// demand moves real funds. Starts in the background and returns at once.
// A run covering due slots records their outcome (complete only on
// zero failures — see lib/claim.ts); a failed run leaves slots retryable.
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ ok: false, error: 'admin password is not configured on the server' }, { status: 503 });
  }
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ ok: false, error: 'admin login required' }, { status: 401 });
  }
  if (isRunning()) {
    return NextResponse.json({ ok: false, error: 'a run is already in progress' }, { status: 409 });
  }
  const due = await dueSlots(new Date());
  runAllWallets(due).catch((err) => console.error('manual claim run failed:', err));
  return NextResponse.json({ ok: true, started: true, dueSlots: due, time: new Date().toISOString() });
}
