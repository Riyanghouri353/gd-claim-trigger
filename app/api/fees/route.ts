import { NextResponse } from 'next/server';
import { checkFees } from '@/lib/fees';
import { getWallets } from '@/lib/wallets';

export const dynamic = 'force-dynamic';

// Manual CELO fee-guard check, outside the schedule: checks every wallet's
// CELO balance and tops up via the GoodDollar faucet wherever it's below
// FEE_THRESHOLD_CELO. Runs IN THE BACKGROUND (a full check can take minutes
// when top-ups are needed) — poll /api/status for the result.
export async function POST() {
  try {
    const wallets = await getWallets();
    checkFees(wallets).catch((e) =>
      console.error('manual fee check failed:', e instanceof Error ? e.message : e),
    );
    return NextResponse.json({ ok: true, started: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'fee check failed' },
      { status: 500 },
    );
  }
}
