// Daily CELO fee guard — proactive gas top-ups.
// At the start of every run, each wallet's CELO balance is checked via the
// gd-claim `status` action. If it's below FEE_THRESHOLD_CELO (default 0.25),
// a free top-up is requested from the GoodDollar faucet relay via `fundGas`
// (address-only — no private key sent).
//
// Fixes (Nov 2026):
// - Single-flight: concurrent callers (scheduled run + manual check) now
//   share one in-flight check instead of throwing "already in progress"
//   and skipping the guard entirely for that run.
// - Verified top-ups: a top-up only counts when the balance actually rises
//   (re-checked up to twice). The old code reported "topped up" even when
//   the balance never moved (Gulam ali, Nov 12: 0.236 -> 0.236).
// - Whitelist-aware: a wallet the endpoint reports as not whitelisted is
//   never sent to the faucet (the faucet rejects it anyway) — it is
//   reported as needing GoodID re-verification instead.
// - Uses the shared gd-claim client (lib/gd.ts): timeout, jittered
//   retries, circuit breaker. Checks run with a bounded pool (6).

import { gdCall } from './gd';
import type { WalletConfig } from './wallets';
import { pMap, sleep } from './limits';

export function getFeeThreshold(): number {
  const v = parseFloat(process.env.FEE_THRESHOLD_CELO || '0.25');
  return Number.isFinite(v) && v > 0 ? v : 0.25;
}

export interface FeeWalletResult {
  label: string;
  balanceBefore: number | null;
  balanceAfter: number | null;
  toppedUp: boolean;
  message?: string;
}

export interface FeeCheckResult {
  checkedAt: string;
  threshold: number;
  wallets: FeeWalletResult[];
}

const FEE_CONCURRENCY = 6;
const FUND_WAIT_MS = 30_000;

async function readCeloBalance(wallet: WalletConfig): Promise<{
  httpStatus: number;
  balance: number | null;
  address: string;
  whitelistError?: string;
  error?: string;
}> {
  const s = await gdCall('status', 'celo', { privateKey: wallet.privateKey });
  if (s.httpStatus !== 200) {
    return { httpStatus: s.httpStatus, balance: null, address: '', error: String(s.error ?? `status HTTP ${s.httpStatus}`) };
  }
  const balance = parseFloat(String(s.gasBalance ?? 'NaN'));
  return {
    httpStatus: 200,
    balance: Number.isFinite(balance) ? balance : null,
    address: String(s.address || ''),
    whitelistError: s.whitelistError ? String(s.whitelistError) : undefined,
  };
}

async function checkWallet(wallet: WalletConfig, threshold: number): Promise<FeeWalletResult> {
  const base = {
    label: wallet.label,
    balanceBefore: null as number | null,
    balanceAfter: null as number | null,
    toppedUp: false,
  };
  if (wallet.loadError) return { ...base, message: wallet.loadError };
  try {
    const s = await readCeloBalance(wallet);
    if (s.httpStatus !== 200) {
      return { ...base, message: s.error ?? `status HTTP ${s.httpStatus}` };
    }
    if (s.whitelistError) {
      // Faucet rejects non-whitelisted wallets — don't waste the call.
      return {
        ...base,
        balanceBefore: s.balance,
        balanceAfter: s.balance,
        message: 'not whitelisted on Celo — faucet cannot help; re-verify GoodID in the GoodDollar app',
      };
    }
    if (s.balance == null) {
      return { ...base, message: 'could not read CELO balance' };
    }
    if (s.balance >= threshold) {
      return { ...base, balanceBefore: s.balance, balanceAfter: s.balance };
    }
    // Below threshold → ask the GoodDollar faucet for a top-up (address only).
    if (!s.address) {
      return { ...base, balanceBefore: s.balance, balanceAfter: s.balance, message: 'low balance but no address returned' };
    }
    const f = await gdCall('fundGas', 'celo', { address: s.address });
    if (f.httpStatus !== 200 || f.ok === false) {
      return {
        ...base,
        balanceBefore: s.balance,
        balanceAfter: s.balance,
        message: `faucet failed: ${String(f.error ?? `HTTP ${f.httpStatus}`)}`,
      };
    }
    // Verify the credit actually landed (faucet relay can lag): re-check
    // twice before concluding. toppedUp requires a real balance increase.
    let after: number | null = null;
    for (let i = 0; i < 2; i++) {
      await sleep(FUND_WAIT_MS);
      const s2 = await readCeloBalance(wallet);
      if (s2.httpStatus === 200 && s2.balance != null) {
        after = s2.balance;
        if (after > s.balance) break;
      }
    }
    const landed = after != null && after > s.balance;
    return {
      ...base,
      balanceBefore: s.balance,
      balanceAfter: after,
      toppedUp: landed,
      message:
        after == null
          ? 'faucet accepted; balance re-check failed'
          : landed
            ? 'topped up from GoodDollar faucet (verified)'
            : 'faucet accepted but balance unchanged after 60s — faucet may be delayed, will retry next run',
    };
  } catch (e) {
    return { ...base, message: e instanceof Error ? e.message : 'fee check failed' };
  }
}

let lastFeeCheck: FeeCheckResult | null = null;
let inFlight: Promise<FeeCheckResult> | null = null;

export function getLastFeeCheck(): FeeCheckResult | null {
  return lastFeeCheck;
}

async function runCheck(wallets: WalletConfig[]): Promise<FeeCheckResult> {
  const threshold = getFeeThreshold();
  const results = await pMap(wallets, (w) => checkWallet(w, threshold), FEE_CONCURRENCY);
  lastFeeCheck = { checkedAt: new Date().toISOString(), threshold, wallets: results };
  return lastFeeCheck;
}

/**
 * Single-flight fee check: concurrent callers share the in-flight run
 * instead of failing. The manual /api/fees check and the scheduled run
 * can no longer starve each other.
 */
export async function checkFees(wallets: WalletConfig[]): Promise<FeeCheckResult> {
  if (inFlight) return inFlight;
  inFlight = runCheck(wallets).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
