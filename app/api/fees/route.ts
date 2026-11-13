import { NextResponse } from 'next/server';
import { checkFees } from '@/lib/fees';
import { checkGasLevels } from '@/lib/gas';
import { addressFromPrivateKey, getWallets } from '@/lib/wallets';
import { isAdminConfigured, isAdminRequest } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

// Manual gas check, outside the schedule: CELO fee-guard check (may top up
// via the GoodDollar faucet) + all-chain gas monitor. Admin-only because
// the fee check can trigger faucet top-ups. Runs IN THE BACKGROUND (a full
// check can take minutes when top-ups are needed) — poll /api/status for
// the result.
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ ok: false, error: 'admin password is not configured on the server' }, { status: 503 });
  }
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ ok: false, error: 'admin login required' }, { status: 401 });
  }
  try {
    const wallets = await getWallets();
    checkFees(wallets).catch((e) =>
      console.error('manual fee check failed:', e instanceof Error ? e.message : e),
    );
    const gasInputs = wallets.map((w) => {
      let address: string | null = null;
      try {
        address = w.loadError ? null : addressFromPrivateKey(w.privateKey);
      } catch {
        address = null;
      }
      return { label: w.label, address, chains: w.chains };
    });
    checkGasLevels(gasInputs).catch((e) =>
      console.error('manual gas check failed:', e instanceof Error ? e.message : e),
    );
    return NextResponse.json({ ok: true, started: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'fee check failed' },
      { status: 500 },
    );
  }
}
