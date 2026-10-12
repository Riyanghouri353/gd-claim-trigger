import { NextResponse } from 'next/server';
import { dueSlots, getClaimTimes, getCompletedSlots, nextRunUtc } from '@/lib/claim';
import { getLastRun, isRunning, runAllWallets } from '@/lib/runner';

export const dynamic = 'force-dynamic';

// Heartbeat endpoint. Hit every 10 minutes (cron-job.org) to keep Render's free
// tier awake; each hit also acts as the clock tick. When one or more schedule
// slots are due, the full run (fee guard + parallel claims) starts IN THE
// BACKGROUND — the response returns immediately so no HTTP timeout can cut it
// off. One run satisfies all due slots (claims are entitlement-based, so a
// single pass covers everything). Slots are marked complete on success only.
export async function GET() {
  const now = new Date();
  const due = dueSlots(now);
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
    nextRunUtc: nextRunUtc(now).toISOString(),
    lastRunSummary: last
      ? { startedAt: last.startedAt, finishedAt: last.finishedAt, summary: last.summary }
      : null,
  });
}
