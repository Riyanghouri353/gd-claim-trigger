import { NextResponse } from 'next/server';
import { getClaimTimes, getSlotStates, nextRunUtc } from '@/lib/claim';
import { getLastFeeCheckResult, getLastGasCheckResult, getLastRun, isRunning } from '@/lib/runner';
import { getFeeThreshold } from '@/lib/fees';
import { getGasThresholds } from '@/lib/gas';
import { getChains, getGdClaimUrl, isDbConfigured, listWallets } from '@/lib/wallets';
import { getAdminSession, isAdminConfigured } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

// Live status for the dashboard (polled every few seconds).
// Wallet keys are NEVER exposed here — only labels, chains, and a decrypt health flag.
// Also reports admin session state (so the UI knows whether destructive
// actions need a login) and the last gas-monitor + slot states.
export async function GET() {
  const now = new Date();
  let wallets: { id: string; label: string; chains: string[]; keyOk: boolean; address: string | null }[] = [];
  let dbError: string | null = null;
  if (isDbConfigured()) {
    try {
      wallets = await listWallets();
    } catch (e) {
      dbError = e instanceof Error ? e.message : 'wallet read failed';
    }
  }
  let isAdmin = false;
  const adminConfigured = isAdminConfigured();
  if (adminConfigured) {
    try {
      isAdmin = !!(await getAdminSession()).admin;
    } catch {
      isAdmin = false;
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
    gasThresholds: getGasThresholds(),
    gasCheck: getLastGasCheckResult(),
    slotStates: getSlotStates(),
    adminConfigured,
    isAdmin,
  });
}
