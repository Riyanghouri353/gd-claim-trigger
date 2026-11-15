import { getClaimTimes, nextRunUtc } from '@/lib/claim';
import { getLastRun, isRunning } from '@/lib/runner';
import { isDbConfigured } from '@/lib/wallets';
import { gdCircuitState } from '@/lib/gd';

export const dynamic = 'force-dynamic';

// Cheap health check for external monitors (dead-man's switch) and load
// balancers. Deliberately does NO database or endpoint calls and NEVER
// triggers a run — unlike /api/wake, which is the scheduler tick.
// Returns just enough to tell "alive + when it last ran" from outside.
//
// Sends an explicit Content-Length (not NextResponse.json's chunked
// body): strict HTTP clients — Python http.client through a proxy —
// intermittently fail on chunked responses whose terminating chunk is
// lost, which caused false "server down" dead-man alerts Nov 14-15
// while the server was up the whole time. A fixed-length body removes
// that failure mode.
function jsonResponse(payload: unknown, status = 200) {
  const body = JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(body).length),
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET() {
  const now = new Date();
  const last = getLastRun();
  return jsonResponse({
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
