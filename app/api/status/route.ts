import { NextResponse } from 'next/server';
import { getClaimTime, nextRunUtc } from '@/lib/claim';
import { getLastRun, isRunning } from '@/lib/runner';
import { getChains, getGdClaimUrl, getWallets } from '@/lib/wallets';

export const dynamic = 'force-dynamic';

// Live status for the dashboard (polled every few seconds). Never exposes keys.
export async function GET() {
  const now = new Date();
  return NextResponse.json({
    ok: true,
    time: now.toISOString(),
    claimTimeUtc: getClaimTime(),
    chains: getChains(),
    walletsConfigured: getWallets().length,
    gdClaimConfigured: getGdClaimUrl().length > 0,
    nextRunUtc: nextRunUtc(now).toISOString(),
    running: isRunning(),
    lastRun: getLastRun(),
  });
}
