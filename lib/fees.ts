// Daily CELO fee guard — proactive gas top-ups.
// At the start of every run, each wallet's CELO balance is checked via the
// gd-claim `status` action. If it's below FEE_THRESHOLD_CELO (default 0.13),
// a free top-up is requested from the GoodDollar faucet relay via `fundGas`
// (address-only — no private key sent). All wallets are checked concurrently.

import { getGdClaimUrl, type WalletConfig } from './wallets';

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

export function getFeeThreshold(): number {
  const v = parseFloat(process.env.FEE_THRESHOLD_CELO || '0.13');
  return Number.isFinite(v) && v > 0 ? v : 0.13;
}

interface GdResponse {
  httpStatus: number;
  [key: string]: unknown;
}

async function gd(action: 'status' | 'fundGas', extra: Record<string, string>): Promise<GdResponse> {
  const res = await fetch(getGdClaimUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, chain: 'celo', ...extra }),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { httpStatus: res.status, ...data };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function checkWallet(wallet: WalletConfig, threshold: number): Promise<FeeWalletResult> {
  const base = {
    label: wallet.label,
    balanceBefore: null as number | null,
    balanceAfter: null as number | null,
    toppedUp: false,
  };
  try {
    const s = await gd('status', { privateKey: wallet.privateKey });
    if (s.httpStatus !== 200) {
      return { ...base, message: String(s.error ?? `status HTTP ${s.httpStatus}`) };
    }
    const balance = parseFloat(String(s.gasBalance ?? 'NaN'));
    if (!Number.isFinite(balance)) {
      return { ...base, message: 'could not read CELO balance' };
    }
    if (balance >= threshold) {
      return { ...base, balanceBefore: balance, balanceAfter: balance };
    }
    // Below threshold → ask the GoodDollar faucet for a top-up (address only).
    const address = String(s.address || '');
    if (!address) {
      return { ...base, balanceBefore: balance, balanceAfter: balance, message: 'low balance but no address returned' };
    }
    const f = await gd('fundGas', { address });
    if (f.httpStatus !== 200 || f.ok === false) {
      return {
        ...base,
        balanceBefore: balance,
        balanceAfter: balance,
        message: `faucet failed: ${String(f.error ?? `HTTP ${f.httpStatus}`)}`,
      };
    }
    await sleep(30_000);
    const s2 = await gd('status', { privateKey: wallet.privateKey });
    const after = s2.httpStatus === 200 ? parseFloat(String(s2.gasBalance ?? 'NaN')) : NaN;
    return {
      ...base,
      balanceBefore: balance,
      balanceAfter: Number.isFinite(after) ? after : balance,
      toppedUp: true,
      message: 'topped up from GoodDollar faucet',
    };
  } catch (e) {
    return { ...base, message: e instanceof Error ? e.message : 'fee check failed' };
  }
}

let lastFeeCheck: FeeCheckResult | null = null;
let checking = false;

export function getLastFeeCheck(): FeeCheckResult | null {
  return lastFeeCheck;
}

export async function checkFees(wallets: WalletConfig[]): Promise<FeeCheckResult> {
  if (checking) {
    if (!lastFeeCheck) throw new Error('a fee check is already in progress');
    return lastFeeCheck;
  }
  checking = true;
  try {
    const threshold = getFeeThreshold();
    // ALL wallets concurrently — no concurrency limit.
    const results = await Promise.all(wallets.map((w) => checkWallet(w, threshold)));
    lastFeeCheck = { checkedAt: new Date().toISOString(), threshold, wallets: results };
    return lastFeeCheck;
  } finally {
    checking = false;
  }
}
