// All-chain gas monitor — the Fee Guard (lib/fees.ts) only watches CELO,
// which is why Fuse gas shortages failed silently run after run. This
// monitor reads NATIVE balances for every chain via public RPC (no private
// keys involved — addresses only) and flags wallets below threshold.
//
// It only REPORTS. The GoodDollar faucet funds CELO only, so FUSE/XDC
// shortages still need a manual top-up from the owner — but now the
// dashboard and the alert email say exactly which wallet, which chain,
// how much it holds, and how much it needs.

import { BALANCE_CHAINS, getChainBalance } from './balances';
import { getFeeThreshold } from './fees';
import { pMap } from './limits';

export interface GasChainStatus {
  chain: string;
  symbol: string;
  balance: number | null;
  threshold: number;
  low: boolean;
  error?: string;
}

export interface GasWalletStatus {
  label: string;
  address: string | null;
  chains: GasChainStatus[];
}

export interface GasCheckResult {
  checkedAt: string;
  thresholds: Record<string, number>;
  wallets: GasWalletStatus[];
}

export function getGasThresholds(): Record<string, number> {
  const num = (raw: string | undefined, fallback: number): number => {
    const v = parseFloat(raw ?? '');
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    // CELO: live claim cost ~0.194 (Nov 2026); 0.25 leaves one-claim headroom.
    celo: getFeeThreshold(),
    // FUSE: observed claim needs 0.0047–0.0087; 0.01 covers them with margin.
    fuse: num(process.env.FEE_THRESHOLD_FUSE, 0.01),
    // XDC: endpoint fee data puts a claim near 0.0057; 0.01 covers it.
    xdc: num(process.env.FEE_THRESHOLD_XDC, 0.01),
  };
}

const GAS_CONCURRENCY = 6;

export async function checkGasLevels(
  wallets: { label: string; address: string | null; chains: string[] }[],
): Promise<GasCheckResult> {
  const thresholds = getGasThresholds();
  const tasks = wallets.flatMap((w) =>
    w.chains.map((chain) => ({ wallet: w, chain })),
  );
  const results = await pMap(
    tasks,
    async ({ wallet, chain }) => {
      const cfg = BALANCE_CHAINS[chain];
      const threshold = thresholds[chain] ?? 0;
      if (!wallet.address) {
        return {
          label: wallet.label,
          chain,
          status: {
            chain,
            symbol: cfg?.nativeSymbol ?? chain.toUpperCase(),
            balance: null,
            threshold,
            low: false,
            error: 'no address yet',
          } satisfies GasChainStatus,
        };
      }
      const bal = await getChainBalance(wallet.address, chain);
      const parsed = bal.native == null ? NaN : parseFloat(bal.native);
      const balance = Number.isFinite(parsed) ? parsed : null;
      return {
        label: wallet.label,
        chain,
        status: {
          chain,
          symbol: cfg?.nativeSymbol ?? chain.toUpperCase(),
          balance,
          threshold,
          low: balance != null && balance < threshold,
          error: bal.error,
        } satisfies GasChainStatus,
      };
    },
    GAS_CONCURRENCY,
  );
  const byLabel = new Map<string, GasWalletStatus>();
  for (const w of wallets) {
    byLabel.set(w.label, { label: w.label, address: w.address, chains: [] });
  }
  for (const r of results) byLabel.get(r.label)?.chains.push(r.status);
  const out: GasCheckResult = {
    checkedAt: new Date().toISOString(),
    thresholds,
    wallets: wallets.map((w) => byLabel.get(w.label) as GasWalletStatus),
  };
  lastGasCheck = out;
  return out;
}

let lastGasCheck: GasCheckResult | null = null;

export function getLastGasCheck(): GasCheckResult | null {
  return lastGasCheck;
}

/** Shortage lines for alerts, e.g. "Green cart FUSE 0.0019 < 0.01". */
export function gasShortages(gas: GasCheckResult | null): string[] {
  if (!gas) return [];
  const lines: string[] = [];
  for (const w of gas.wallets) {
    for (const c of w.chains) {
      if (c.low && c.balance != null) {
        lines.push(`${w.label} ${c.symbol} ${c.balance} < ${c.threshold}`);
      }
    }
  }
  return lines;
}
