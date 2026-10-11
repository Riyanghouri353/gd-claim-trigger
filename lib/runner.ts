// Parallel claim engine — talks to the gd-claim function DIRECTLY.
// Flow per wallet × chain (per the gd-claim API contract):
//   status → (gas short? fundGas [CELO only, address-only] → wait 30s → re-status) → claim
// Parallelism: ALL wallets and ALL chains run concurrently via Promise.all —
// no concurrency limit, exactly as requested.

import { getGdClaimUrl, getWallets, type WalletConfig } from './wallets';

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

async function gdClaim(
  action: 'status' | 'claim' | 'fundGas',
  chain: string,
  extra: Record<string, string>,
): Promise<GdResponse> {
  const res = await fetch(getGdClaimUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, chain, ...extra }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { httpStatus: res.status, ...data };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  // every chain of this wallet in parallel
  const chains = await Promise.all(wallet.chains.map((c) => runChain(wallet, c)));
  return { label: wallet.label, chains };
}

let lastRun: RunResult | null = null;
let running = false;

export function getLastRun(): RunResult | null {
  return lastRun;
}

export function isRunning(): boolean {
  return running;
}

export async function runAllWallets(): Promise<RunResult> {
  if (running) {
    if (!lastRun) throw new Error('a run is already in progress');
    return lastRun;
  }
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const wallets = getWallets();
    // ALL wallets concurrently — no concurrency limit.
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
    return lastRun;
  } finally {
    running = false;
  }
}
