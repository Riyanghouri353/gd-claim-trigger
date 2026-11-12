// Parallel claim engine — talks to the gd-claim function DIRECTLY.
// Two phases per run:
//   1. Fee guard (lib/fees.ts): daily CELO balance check per wallet; below
//      FEE_THRESHOLD_CELO (default 0.13) → fundGas via the GoodDollar faucet.
//   2. Claims per wallet × chain (per the gd-claim API contract):
//      status → (gas short? fundGas [CELO only, address-only] → wait 30s → re-status) → claim
// Parallelism: ALL wallets and ALL chains run concurrently via Promise.all —
// no concurrency limit, exactly as requested.

import { getGdClaimUrl, getWallets, type WalletConfig } from './wallets';
import { checkFees, getLastFeeCheck, type FeeCheckResult } from './fees';
import { markSlotsComplete } from './claim';
import { alertRunCrashed, maybeAlertRunFailures } from './alerts';

export type ChainStatus = 'claimed' | 'skipped' | 'failed';

export interface ChainResult {
  chain: string;
  status: ChainStatus;
  amount?: string;
  txHash?: string;
  explorerUrl?: string;
  message?: string;
  fundedGas?: boolean;
}

export interface WalletResult {
  label: string;
  chains: ChainResult[];
}

export interface RunResult {
  startedAt: string;
  finishedAt: string;
  wallets: WalletResult[];
  summary: { claimed: number; skipped: number; failed: number };
}

interface GdResponse {
  httpStatus: number;
  [key: string]: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Retry policy for the gd-claim endpoint (Nov 2026 failures):
 * - HTTP 5xx (incl. Supabase 546 function errors) — endpoint-side, transient.
 * - "gas fee cap is below the minimum base fee" — Celo base-fee spike at
 *   broadcast time; the tx was never mined, entitlement untouched, so a
 *   retry seconds later (when the fee settles) is safe.
 * Retries: 2, at 15s and 45s. Status is read-only; claim re-checks
 * entitlement server-side, so a retry can never double-claim. */
const RETRY_DELAYS_MS = [15_000, 45_000];

function isRetryableGd(httpStatus: number, errorText: string): boolean {
  if (httpStatus >= 500) return true;
  if (/gas fee cap is below the minimum base fee/i.test(errorText)) return true;
  return false;
}

async function gdClaim(
  action: 'status' | 'claim' | 'fundGas',
  chain: string,
  extra: Record<string, string>,
): Promise<GdResponse> {
  let last: GdResponse | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(getGdClaimUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, chain, ...extra }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const out: GdResponse = { httpStatus: res.status, ...data };
      if (!isRetryableGd(res.status, String(data.error ?? '')) || attempt === RETRY_DELAYS_MS.length) {
        return out;
      }
      last = out;
    } catch (e) {
      lastErr = e;
      if (attempt === RETRY_DELAYS_MS.length) throw e;
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  if (last) return last;
  throw lastErr ?? new Error('gd-claim request failed');
}

async function runChain(wallet: WalletConfig, chain: string): Promise<ChainResult> {
  const pk = wallet.privateKey;
  try {
    let s = await gdClaim('status', chain, { privateKey: pk });
    if (s.httpStatus !== 200) {
      return { chain, status: 'failed', message: String(s.error ?? `status HTTP ${s.httpStatus}`) };
    }
    if (s.whitelistError) {
      return { chain, status: 'skipped', message: String(s.whitelistError) };
    }
    if (!s.canClaim || parseFloat(String(s.entitlement ?? '0')) <= 0) {
      return { chain, status: 'skipped', message: 'No entitlement available right now' };
    }

    let fundedGas = false;
    const fee = s.fee as Record<string, unknown> | undefined;
    const need = parseFloat(String(fee?.totalCost ?? '0'));
    const have = parseFloat(String(s.gasBalance ?? '0'));
    if (need > 0 && have < need) {
      // The GoodDollar faucet tops up CELO gas only — address is enough, no key sent.
      if (chain === 'celo' && s.address) {
        const f = await gdClaim('fundGas', chain, { address: String(s.address) });
        if (f.httpStatus === 200 && f.ok !== false) {
          fundedGas = true;
          await sleep(30_000);
          s = await gdClaim('status', chain, { privateKey: pk });
          if (s.httpStatus !== 200) {
            return { chain, status: 'failed', fundedGas, message: String(s.error ?? 're-check failed after funding') };
          }
          if (!s.canClaim || parseFloat(String(s.entitlement ?? '0')) <= 0) {
            return { chain, status: 'skipped', fundedGas, message: 'No entitlement after gas funding' };
          }
          // Don't attempt a claim that's still short on gas — fail fast instead.
          const needAfter = parseFloat(String((s.fee as Record<string, unknown> | undefined)?.totalCost ?? '0'));
          const haveAfter = parseFloat(String(s.gasBalance ?? '0'));
          if (needAfter > 0 && haveAfter < needAfter) {
            return {
              chain,
              status: 'failed',
              fundedGas,
              message: `Gas still insufficient after faucet: need ~${needAfter}, have ${haveAfter}`,
            };
          }
        } else {
          return {
            chain,
            status: 'failed',
            fundedGas,
            message: `Low gas and faucet failed: ${String(f.error ?? `HTTP ${f.httpStatus}`)}`,
          };
        }
      } else {
        return {
          chain,
          status: 'failed',
          message: `Insufficient ${chain.toUpperCase()} for gas: need ~${need}, have ${have}`,
        };
      }
    }

    const c = await gdClaim('claim', chain, { privateKey: pk });
    if (c.txHash) {
      return {
        chain,
        status: 'claimed',
        amount: c.amount ? String(c.amount) : undefined,
        txHash: String(c.txHash),
        explorerUrl: c.explorerUrl ? String(c.explorerUrl) : undefined,
        fundedGas,
      };
    }
    return { chain, status: 'failed', fundedGas, message: String(c.error ?? `claim HTTP ${c.httpStatus}`) };
  } catch (e) {
    return { chain, status: 'failed', message: e instanceof Error ? e.message : 'unknown error' };
  }
}

async function runWallet(wallet: WalletConfig): Promise<WalletResult> {
  // A wallet whose key can't be decrypted fails loudly on its own —
  // it never takes the other wallets down with it.
  if (wallet.loadError) {
    return {
      label: wallet.label,
      chains: wallet.chains.map((c) => ({ chain: c, status: 'failed' as ChainStatus, message: wallet.loadError })),
    };
  }
  // every chain of this wallet in parallel
  const chains = await Promise.all(wallet.chains.map((c) => runChain(wallet, c)));
  return { label: wallet.label, chains };
}

let lastRun: RunResult | null = null;
let running = false;

export function getLastRun(): RunResult | null {
  return lastRun;
}

export function getLastFeeCheckResult(): FeeCheckResult | null {
  return getLastFeeCheck();
}

export function isRunning(): boolean {
  return running;
}

/** Run the full cycle (fee guard + parallel claims).
 *  dueSlotKeys: the schedule slots this run satisfies — marked complete on
 *  success ONLY, so a failed run stays eligible for retry on a later tick. */
export async function runAllWallets(dueSlotKeys: string[] = []): Promise<RunResult> {
  if (running) {
    if (!lastRun) throw new Error('a run is already in progress');
    return lastRun;
  }
  running = true;
  const startedAt = new Date().toISOString();
  const slotLabel = dueSlotKeys.length > 0 ? dueSlotKeys.join(', ') : 'manual run';
  try {
    const wallets = await getWallets();
    // Phase 1 — daily CELO fee guard: top up any wallet below the threshold
    // via the GoodDollar faucet before claims are attempted.
    // Never fatal: a fee-guard failure must not block claims.
    let feeResult: FeeCheckResult | null = null;
    try {
      feeResult = await checkFees(wallets);
    } catch (e) {
      console.error('fee guard failed (claims continue):', e instanceof Error ? e.message : e);
    }
    // Phase 2 — ALL wallets concurrently — no concurrency limit.
    const results = await Promise.all(wallets.map(runWallet));
    const finishedAt = new Date().toISOString();
    let claimed = 0;
    let skipped = 0;
    let failed = 0;
    for (const w of results) {
      for (const c of w.chains) {
        if (c.status === 'claimed') claimed++;
        else if (c.status === 'skipped') skipped++;
        else failed++;
      }
    }
    lastRun = { startedAt, finishedAt, wallets: results, summary: { claimed, skipped, failed } };
    markSlotsComplete(dueSlotKeys); // success only — a failed run stays eligible for retry
    // Email alert on failures (never breaks the run; dupes throttled to 12h).
    try {
      await maybeAlertRunFailures({
        slotLabel,
        startedAt,
        finishedAt,
        results,
        summary: { claimed, skipped, failed },
        fee: feeResult,
      });
    } catch (e) {
      console.error('failure alert failed:', e instanceof Error ? e.message : e);
    }
    return lastRun;
  } catch (e) {
    // The whole run crashed — alert immediately (slot stays eligible for retry).
    try {
      await alertRunCrashed(slotLabel, startedAt, e instanceof Error ? e.message : String(e));
    } catch (ae) {
      console.error('crash alert failed:', ae instanceof Error ? ae.message : ae);
    }
    throw e;
  } finally {
    running = false;
  }
}
