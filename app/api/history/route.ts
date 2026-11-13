import { NextResponse } from 'next/server';
import { getRunHistory, getWalletStats } from '@/lib/history';

export const dynamic = 'force-dynamic';

// Run history for the dashboard Logs tab: recent runs (newest first) plus
// per-wallet x chain aggregates for the last 7 days. Labels and results
// only — never keys. Public read, same as /api/status.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(searchParams.get('limit') ?? 10) || 10));
  try {
    const [runs, stats] = await Promise.all([getRunHistory(limit), getWalletStats(7)]);
    return NextResponse.json({ ok: true, runs, stats });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'history read failed' },
      { status: 500 },
    );
  }
}
