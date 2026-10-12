import { NextResponse } from 'next/server';
import { getClaimTime, getLastRunDate, isDue, nextRunUtc } from '@/lib/claim';
import { getLastRun, isRunning, runAllWallets } from '@/lib/runner';

export const dynamic = 'force-dynamic';

// Heartbeat endpoint. Hit every 10 minutes (cron-job.org) to keep Render's free
// tier awake; each hit also acts as the clock tick. When the claim time is due,
// the full run (fee guard + parallel claims) starts IN THE BACKGROUND — the
// response returns immediately so no HTTP timeout can cut it off.
// runAllWallets marks the day complete itself, and only on success.
export async function GET() {
  const now = new Date();
  const due = isDue(now);
  let started = false;

  if (due && !isRunning()) {
    started = true;
    runAllWallets().catch((err) => console.error('background claim run failed:', err));
  }

  const last = getLastRun();
  return NextResponse.json({
    ok: true,
    time: now.toISOString(),
    claimTimeUtc: getClaimTime(),
    due,
    running: isRunning(),
    started,
    lastTriggeredRun: getLastRunDate(),
    nextRunUtc: nextRunUtc(now).toISOString(),
    lastRunSummary: last
      ? { startedAt: last.startedAt, finishedAt: last.finishedAt, summary: last.summary }
      : null,
  });
}
