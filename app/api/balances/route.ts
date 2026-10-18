import { NextResponse } from 'next/server';
import { ensureAddresses, isDbConfigured, listWallets } from '@/lib/wallets';
import { getWalletBalances } from '@/lib/balances';

export const dynamic = 'force-dynamic';

// Live wallet balances (native + G$ per chain) for the Vault screen.
// Uses the stored address column — private keys are never touched.
// All wallets × chains are fetched in parallel; one slow chain can't block the rest.
export async function GET() {
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: 'vault not configured' }, { status: 400 });
  }
  try {
    await ensureAddresses(); // one-time backfill for rows added before the address column
    const wallets = await listWallets();
    const withAddress = wallets.filter((w) => w.address);
    const balances = await getWalletBalances(
      withAddress.map((w) => ({ id: w.id, label: w.label, address: w.address as string, chains: w.chains })),
    );
    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      wallets: balances,
      missingAddress: wallets.length - withAddress.length,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'balance lookup failed' },
      { status: 500 },
    );
  }
}
