import { NextResponse } from 'next/server';
import { isRunning, runAllWallets } from '@/lib/runner';

export const dynamic = 'force-dynamic';

// Manual immediate run (dashboard button). Starts in the background and returns at once.
// A successful manual run marks today complete (suppressing the scheduled tick);
// a failed one does not, so the schedule still retries later.
export async function POST() {
  if (isRunning()) {
    return NextResponse.json({ ok: false, error: 'a run is already in progress' }, { status: 409 });
  }
  runAllWallets().catch((err) => console.error('manual claim run failed:', err));
  return NextResponse.json({ ok: true, started: true, time: new Date().toISOString() });
}
