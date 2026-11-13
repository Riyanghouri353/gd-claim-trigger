// Parallel claim engine — talks to the gd-claim function DIRECTLY.
// Three phases per run:
//   1. Fee guard (lib/fees.ts): CELO balance check per wallet; below
//      FEE_THRESHOLD_CELO (default 0.25) → fundGas via the GoodDollar faucet.
//   1b. Gas monitor (lib/gas.ts): RPC-only native-balance check for ALL
//      chains — reports FUSE/XDC shortages the faucet can't fix.
//   2. Claims per wallet × chain (per the gd-claim API contract):
//      status → (gas short? fundGas [CELO only, address-only] → wait 30s →
//      re-status, twice) → claim. A wallet the endpoint reports as NOT
//      whitelisted is "blocked" (needs GoodID re-verification), not a
//      silent skip and not a retryable failure.
// Parallelism: bounded pool (6 in flight) via pMap — the old unbounded
// burst tripped RPC/endpoint rate limits. Slot outcomes persist in
// Supabase: a slot completes only on a zero-failure run or after 3
// attempts (see lib/claim.ts). Every run is recorded to run history.

import { addressFromPrivateKey, getWallets, type WalletConfig } from './wallets';
import { checkFees, getLastFeeCheck, type FeeCheckResult } from './fees';
import { checkGasLevels, getLastGasCheck, type GasCheckResult } from './gas';
import { gdCall } from './gd';
import { recordSlotOutcome } from './claim';
import { recordRun } from './history';
import { alertRunCrashed, maybeAlertRunFailures } from './alerts';
import { pMap, sleep } from './limits';

export type ChainStatus = 'claimed' | 'skipped' | 'failed' | 'blocked';

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
  summary: { claimed: number; skipped: number; failed: number; blocked: number };
}

const CLAIM_CONCURRENCY = 6;
const FUND_WAIT_MS = 30_000;
/** A run older than this is presumed dead (hung call, crashed worker) and
 *  no longer blocks the next tick. */
const STALE_RUN_MS = 20 * 60_000;

async function runChain(wallet: WalletConfig, chain: string): Promise<ChainResult> {
  const pk = wallet.privateKey;
  try {
    let s = await gdCall('status', chain, { privateKey: pk });
    if (s.httpStatus !== 200) {
      return { chain, status: 'failed', message: String(s.error ?? `status HTTP ${s.httpStatus}`) };
    }
    if (s.whitelistError) {
      // Verification lost/expired: retrying cannot fix it, and hiding it
      // as a skip lost real entitlement unnoticed. Distinct status so the
      // dashboard and alerts call it out.
      return { chain, status: 'blocked', message: String(s.whitelistError) };
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
        const f = await gdCall('fundGas', chain, { address: String(s.address) });
        if (f.httpStatus === 200 && f.ok !== false) {
          fundedGas = true;
          // Faucet credit can lag: re-check twice before giving up.
          for (let i = 0; i < 2; i++) {
            await sleep(FUND_WAIT_MS);
            s = await gdCall('status', chain, { privateKey: pk });
            if (s.httpStatus !== 200) {
              return { chain, status: 'failed', fundedGas, message: String(s.error ?? 're-check failed after funding') };
            }
            if (!s.canClaim || parseFloat(String(s.entitlement ?? '0')) <= 0) {
              return { chain, status: 'skipped', fundedGas, message: 'No entitlement after gas funding' };
            }
            const needAfter = parseFloat(String((s.fee as Record<string, unknown> | undefined)?.totalCost ?? '0'));
            const haveAfter = parseFloat(String(s.gasBalance ?? '0'));
            if (!(needAfter > 0 && haveAfter < needAfter)) break;
            if (i === 1) {
              return {
                chain,
                status: 'failed',
                fundedGas,
                message: `Gas still insufficient after faucet: need ~${needAfter}, have ${haveAfter}`,
              };
            }
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

    const c = await gdCall('claim', chain, { privateKey: pk });
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

let lastRun: RunResult | null = null;
let running = false;
let runningSince: number | null = null;
let runToken = 0;

export function getLastRun(): RunResult | null {
  return lastRun;
}

export function getLastFeeCheckResult(): FeeCheckResult | null {
  return getLastFeeCheck();
}

export function getLastGasCheckResult(): GasCheckResult | null {
  return getLastGasCheck();
}

function isStale(): boolean {
  return running && runningSince != null && Date.now() - runningSince > STALE_RUN_MS;
}

export function isRunning(): boolean {
  if (!running) return false;
  if (isStale()) {
    console.warn('runner: previous run exceeded stale threshold — treating as dead');
    return false;
  }
  return true;
}

/** Run the full cycle (fee guard + gas monitor + claims).
 *  dueSlotKeys: the schedule slots this run satisfies — recorded with
 *  their outcome; only zero-failure runs (or exhausted slots) complete. */
export async function runAllWallets(dueSlotKeys: string[] = []): Promise<RunResult> {
  if (isRunning()) {
    if (!lastRun) throw new Error('a run is already in progress');
    return lastRun;
  }
  const myToken = ++runToken;
  running = true;
  runningSince = Date.now();
  const startedAt = new Date().toISOString();
  const slotLabel = dueSlotKeys.length > 0 ? dueSlotKeys.join(', ') : 'manual run';
  try {
    const wallets = await getWallets();
    // Phase 1 — fee guard + gas monitor, concurrently. Neither is fatal:
    // a guard failure must not block claims.
    let feeResult: FeeCheckResult | null = null;
    let gasResult: GasCheckResult | null = null;
    if (wallets.length > 0) {
      const gasInputs = wallets.map((w) => {
        let address: string | null = null;
        try {
          address = w.loadError ? null : addressFromPrivateKey(w.privateKey);
        } catch {
          address = null;
        }
        return { label: w.label, address, chains: w.chains };
      });
      const [feeSettled, gasSettled] = await Promise.allSettled([
        checkFees(wallets),
        checkGasLevels(gasInputs),
      ]);
      if (feeSettled.status === 'fulfilled') feeResult = feeSettled.value;
      else console.error('fee guard failed (claims continue):', feeSettled.reason instanceof Error ? feeSettled.reason.message : feeSettled.reason);
      if (gasSettled.status === 'fulfilled') gasResult = gasSettled.value;
      else console.error('gas monitor failed (claims continue):', gasSettled.reason instanceof Error ? gasSettled.reason.message : gasSettled.reason);
    }
    // Phase 2 — bounded-parallel claims over the flat wallet x chain list.
    // A wallet whose key can't be decrypted fails loudly on its own —
    // it never takes the other wallets down with it.
    const tasks = wallets.flatMap((wallet, walletIdx) => wallet.chains.map((chain) => ({ wallet, walletIdx, chain })));
    const flat = await pMap(
      tasks,
      async ({ wallet, chain }) =>
        wallet.loadError
          ? ({ chain, status: 'failed' as ChainStatus, message: wallet.loadError } satisfies ChainResult)
          : runChain(wallet, chain),
      CLAIM_CONCURRENCY,
    );
    const results: WalletResult[] = wallets.map((w) => ({ label: w.label, chains: [] }));
    tasks.forEach((t, i) => {
      results[t.walletIdx].chains.push(flat[i]);
    });
    const finishedAt = new Date().toISOString();
    let claimed = 0;
    let skipped = 0;
    let failed = 0;
    let blocked = 0;
    for (const w of results) {
      for (const c of w.chains) {
        if (c.status === 'claimed') claimed++;
        else if (c.status === 'skipped') skipped++;
        else if (c.status === 'blocked') blocked++;
        else failed++;
      }
    }
    const summary = { claimed, skipped, failed, blocked };
    const completed: RunResult = { startedAt, finishedAt, wallets: results, summary };
    // Only the current run may publish results / clear the running flag.
    if (myToken === runToken) lastRun = completed;
    // Persist slot outcome (retryable on failure) + run history. Neither throws.
    await recordSlotOutcome(dueSlotKeys, summary);
    await recordRun({
      startedAt,
      finishedAt,
      slotLabel,
      wallets: results,
      summary,
      feeSummary: feeResult
        ? {
            threshold: feeResult.threshold,
            checkedAt: feeResult.checkedAt,
            toppedUp: feeResult.wallets.filter((w) => w.toppedUp).length,
            checkFailed: feeResult.wallets.filter((w) => w.balanceBefore == null).length,
          }
        : null,
    });
    // Email alert on failures/blocked (never breaks the run; dupes throttled).
    try {
      await maybeAlertRunFailures({
        slotLabel,
        startedAt,
        finishedAt,
        results,
        summary,
        fee: feeResult,
        gas: gasResult,
      });
    } catch (e) {
      console.error('failure alert failed:', e instanceof Error ? e.message : e);
    }
    return completed;
  } catch (e) {
    // The whole run crashed — alert immediately (slot stays eligible for retry).
    try {
      await alertRunCrashed(slotLabel, startedAt, e instanceof Error ? e.message : String(e));
    } catch (ae) {
      console.error('crash alert failed:', ae instanceof Error ? ae.message : ae);
    }
    throw e;
  } finally {
    if (myToken === runToken) {
      running = false;
      runningSince = null;
    }
  }
}
