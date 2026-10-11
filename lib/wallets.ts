// Wallet configuration — read from environment at runtime.
// WALLETS_JSON: JSON array, e.g.
//   [{"label":"Wallet 1","privateKey":"0x..."},{"label":"Wallet 2","privateKey":"0x...","chains":["celo"]}]
// Keys live ONLY in server env vars (Render dashboard → Environment), never in code or git.

export interface WalletConfig {
  label: string;
  privateKey: string;
  chains: string[];
}

export const DEFAULT_GD_CLAIM_URL =
  'https://uiwsjxfcdruvqnbgdwdd.supabase.co/functions/v1/gd-claim';

export function getGdClaimUrl(): string {
  return process.env.GD_CLAIM_URL || DEFAULT_GD_CLAIM_URL;
}

export function getChains(): string[] {
  return (process.env.CHAINS || 'celo,xdc,fuse')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function getWallets(): WalletConfig[] {
  let arr: unknown[] = [];
  try {
    const parsed = JSON.parse(process.env.WALLETS_JSON || '[]');
    if (Array.isArray(parsed)) arr = parsed;
  } catch {
    arr = [];
  }
  const defaultChains = getChains();
  return arr
    .filter(
      (w): w is Record<string, unknown> =>
        !!w && typeof w === 'object' && typeof (w as Record<string, unknown>).privateKey === 'string',
    )
    .map((w, i) => ({
      label: typeof w.label === 'string' && w.label ? w.label : `Wallet ${i + 1}`,
      privateKey: w.privateKey as string,
      chains:
        Array.isArray(w.chains) && w.chains.length > 0
          ? (w.chains as unknown[]).map((c) => String(c).toLowerCase())
          : defaultChains,
    }));
}
