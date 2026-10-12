import { NextResponse } from 'next/server';
import { checkFees } from '@/lib/fees';
import { getWallets } from '@/lib/wallets';

export const dynamic = 'force-dynamic';

// Manual CELO fee-guard check, outside the schedule: checks every wallet's
// CELO balance and tops up via the GoodDollar faucet wherever it's below
// FEE_THRESHOLD_CELO. Read-only unless a top-up is actually needed.
export async function POST() {
  try {
    const wallets = await getWallets();
    const result = await checkFees(wallets);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'fee check failed' },
      { status: 500 },
    );
  }
}
