import { NextResponse } from 'next/server';
import { dueSlots, getClaimTimes, getCompletedSlots, getSlotStates, nextRunUtc } from '@/lib/claim';
import { getLastRun, isRunning, runAllWallets } from '@/lib/runner';

export const dynamic = 'force-dynamic';

// Heartbeat endpoint. Hit every 10 minutes (cron-job.org) to keep Render's free
// tier awake; each hit also acts as the clock tick. When one or more schedule
// slots are due, the full run (fee guard + gas monitor + claims) starts IN THE
// BACKGROUND — the response returns immediately so no HTTP timeout can cut it
// off. One run satisfies all due slots (claims are entitlement-based, so a
// single pass covers everything). Slots complete only on zero-failure runs
// (or after 3 attempts); failed slots stay due with a 30-minute retry gap
// (see lib/claim.ts). This endpoint stays unauthenticated: it can only
// start due scheduled runs, never add/remove wallets or move funds.
export async function GET() {
  const now = new Date();
  const due = await dueSlots(now);
  let started = false;

  if (due.length > 0 && !isRunning()) {
    started = true;
    runAllWallets(due).catch((err) => console.error('background claim run failed:', err));
  }

  const last = getLastRun();
  return NextResponse.json({
    ok: true,
    time: now.toISOString(),
    claimTimesUtc: getClaimTimes(),
    due: due.length > 0,
    dueSlots: due,
    running: isRunning(),
    started,
    completedSlots: getCompletedSlots(),
    slotStates: getSlotStates(),
    nextRunUtc: nextRunUtc(now).toISOString(),
    lastRunSummary: last
      ? { startedAt: last.startedAt, finishedAt: last.finishedAt, summary: last.summary }
      : null,
  });
}
