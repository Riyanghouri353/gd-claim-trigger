import { NextResponse } from 'next/server';
import { markRan } from '@/lib/claim';
import { isRunning, runAllWallets } from '@/lib/runner';

export const dynamic = 'force-dynamic';

// Manual immediate run (dashboard button). Starts in the background and returns at once.
export async function POST() {
  if (isRunning()) {
    return NextResponse.json({ ok: false, error: 'a run is already in progress' }, { status: 409 });
  }
  markRan(); // keep the scheduled tick from double-running today
  runAllWallets().catch((err) => console.error('manual claim run failed:', err));
  return NextResponse.json({ ok: true, started: true, time: new Date().toISOString() });
}
