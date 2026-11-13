import { NextResponse } from 'next/server';
import { getClaimTimes, nextRunUtc } from '@/lib/claim';
import { getLastRun, isRunning } from '@/lib/runner';
import { isDbConfigured } from '@/lib/wallets';
import { gdCircuitState } from '@/lib/gd';

export const dynamic = 'force-dynamic';

// Cheap health check for external monitors (dead-man's switch) and load
// balancers. Deliberately does NO database or endpoint calls and NEVER
// triggers a run — unlike /api/wake, which is the scheduler tick.
// Returns just enough to tell "alive + when it last ran" from outside.
export async function GET() {
  const now = new Date();
  const last = getLastRun();
  return NextResponse.json({
    ok: true,
    time: now.toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    dbConfigured: isDbConfigured(),
    claimTimesUtc: getClaimTimes(),
    nextRunUtc: nextRunUtc(now).toISOString(),
    running: isRunning(),
    lastRun: last
      ? { startedAt: last.startedAt, finishedAt: last.finishedAt, summary: last.summary }
      : null,
    gdCircuit: gdCircuitState(),
  });
}
