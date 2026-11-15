import { getRunHistory, getWalletStats } from '@/lib/history';

export const dynamic = 'force-dynamic';

// Run history for the dashboard Logs tab: recent runs (newest first) plus
// per-wallet x chain aggregates for the last 7 days. Labels and results
// only — never keys. Public read, same as /api/status.
//
// Sends an explicit Content-Length (see /api/health): chunked bodies
// intermittently break strict HTTP clients through proxies and caused
// false "server down" dead-man alerts Nov 14-15.
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

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(searchParams.get('limit') ?? 10) || 10));
  try {
    const [runs, stats] = await Promise.all([getRunHistory(limit), getWalletStats(7)]);
    return jsonResponse({ ok: true, runs, stats });
  } catch (e) {
    return jsonResponse(
      { ok: false, error: e instanceof Error ? e.message : 'history read failed' },
      500,
    );
  }
}
