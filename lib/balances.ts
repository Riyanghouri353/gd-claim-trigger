// Live balance lookups (native + G$) via public JSON-RPC.
// No private keys needed — addresses come from the claim_wallets.address column.
// EVERYTHING runs in parallel: all wallets × all chains × both RPC calls,
// with per-chain RPC fallback (each RPC tried in order until one answers).

export interface ChainBalance {
  chain: string;
  native: string | null; // formatted, e.g. "0.0523"
  nativeSymbol: string;
  gd: string | null; // formatted G$ balance
  error?: string;
}

export interface WalletBalances {
  id: string;
  label: string;
  address: string;
  chains: ChainBalance[];
}

interface ChainCfg {
  nativeSymbol: string;
  rpcs: string[];
  gdAddress: string;
  gdDecimals: number;
}

export const BALANCE_CHAINS: Record<string, ChainCfg> = {
  celo: {
    nativeSymbol: 'CELO',
    rpcs: ['https://forno.celo.org', 'https://rpc.ankr.com/celo'],
    gdAddress: '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A',
    gdDecimals: 18,
  },
  fuse: {
    nativeSymbol: 'FUSE',
    rpcs: ['https://rpc.fuse.io', 'https://fuse.drpc.org'],
    gdAddress: '0x495d133B938596C9984d462F007B676bDc57eCEC',
    gdDecimals: 2,
  },
  xdc: {
    nativeSymbol: 'XDC',
    rpcs: ['https://rpc.ankr.com/xdc', 'https://erpc.xdcrpc.com', 'https://rpc.xdc.org'],
    gdAddress: '0xEC2136843a983885AebF2feB3931F73A8eBEe50c',
    gdDecimals: 18,
  },
};

const RPC_TIMEOUT_MS = 15_000;
const BALANCE_OF_SELECTOR = '0x70a08231'; // balanceOf(address)

function balanceOfData(address: string): string {
  return BALANCE_OF_SELECTOR + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { result?: string; error?: { message?: string } };
    if (data.error) throw new Error(data.error.message || 'rpc error');
    if (typeof data.result !== 'string') throw new Error('bad rpc response');
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

/** Try each RPC in order until one answers. */
async function rpcWithFallback(rpcs: string[], method: string, params: unknown[]): Promise<string> {
  let lastErr = 'all RPCs failed';
  for (const url of rpcs) {
    try {
      return await rpcCall(url, method, params);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastErr);
}

function formatUnits(hex: string, decimals: number): string {
  const v = BigInt(hex);
  const neg = v < BigInt(0);
  const abs = neg ? -v : v;
  let base = BigInt(1);
  for (let i = 0; i < decimals; i++) base = base * BigInt(10);
  const int = (abs / base).toString();
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, 6);
  return (neg ? '-' : '') + int + (frac ? `.${frac}` : '');
}

export async function getChainBalance(address: string, chain: string): Promise<ChainBalance> {
  const cfg = BALANCE_CHAINS[chain];
  if (!cfg) {
    return { chain, native: null, nativeSymbol: chain.toUpperCase(), gd: null, error: 'unsupported chain' };
  }
  try {
    const [nativeRaw, gdRaw] = await Promise.all([
      rpcWithFallback(cfg.rpcs, 'eth_getBalance', [address, 'latest']),
      rpcWithFallback(cfg.rpcs, 'eth_call', [{ to: cfg.gdAddress, data: balanceOfData(address) }, 'latest']),
    ]);
    return {
      chain,
      native: formatUnits(nativeRaw, 18),
      nativeSymbol: cfg.nativeSymbol,
      gd: formatUnits(gdRaw, cfg.gdDecimals),
    };
  } catch (e) {
    return {
      chain,
      native: null,
      nativeSymbol: cfg.nativeSymbol,
      gd: null,
      error: e instanceof Error ? e.message : 'balance lookup failed',
    };
  }
}

/** All wallets × all chains concurrently — no concurrency limit. */
export async function getWalletBalances(
  wallets: { id: string; label: string; address: string; chains: string[] }[],
): Promise<WalletBalances[]> {
  return Promise.all(
    wallets.map(async (w) => ({
      id: w.id,
      label: w.label,
      address: w.address,
      chains: await Promise.all(w.chains.map((c) => getChainBalance(w.address, c))),
    })),
  );
}
