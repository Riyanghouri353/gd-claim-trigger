import { NextResponse } from 'next/server';
import { getClaimTimes, nextRunUtc } from '@/lib/claim';
import { getLastFeeCheckResult, getLastRun, isRunning } from '@/lib/runner';
import { getFeeThreshold } from '@/lib/fees';
import { getChains, getGdClaimUrl, isDbConfigured, listWallets } from '@/lib/wallets';

export const dynamic = 'force-dynamic';

// Live status for the dashboard (polled every few seconds).
// Wallet keys are NEVER exposed here — only labels, chains, and a decrypt health flag.
export async function GET() {
  const now = new Date();
  let wallets: { label: string; chains: string[]; keyOk: boolean }[] = [];
  let dbError: string | null = null;
  if (isDbConfigured()) {
    try {
      wallets = await listWallets();
    } catch (e) {
      dbError = e instanceof Error ? e.message : 'wallet read failed';
    }
  }
  return NextResponse.json({
    ok: true,
    time: now.toISOString(),
    claimTimesUtc: getClaimTimes(),
    chains: getChains(),
    dbConfigured: isDbConfigured(),
    dbError,
    walletsConfigured: wallets.length,
    wallets,
    gdClaimConfigured: getGdClaimUrl().length > 0,
    nextRunUtc: nextRunUtc(now).toISOString(),
    running: isRunning(),
    lastRun: getLastRun(),
    feeThreshold: getFeeThreshold(),
    feeCheck: getLastFeeCheckResult(),
  });
}
