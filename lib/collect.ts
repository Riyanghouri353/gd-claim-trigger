// G$ collection engine: sweep G$ from all wallets → fresh collection wallet → main account.
// Server-side signing with ethers. Collection wallet keys are encrypted and saved to
// the DB BEFORE any transfer is attempted, and are NEVER deleted.

import { Contract, JsonRpcProvider, Wallet, parseUnits } from 'ethers';
import { alertCollectionFinished } from './alerts';
import { BALANCE_CHAINS } from './balances';
import { decryptPrivateKey, encryptPrivateKey } from './crypto';
import { getCollectionSettings, setSetting } from './settings';
import { addressFromPrivateKey, getGdClaimUrl, getWallets, supaEnv, type WalletConfig } from './wallets';

const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';
const BALANCE_OF_SELECTOR = '0x70a08231';
const FUNDING_BUFFER_NUM = 3; // ×1.5 buffer on gas funding
const FUNDING_BUFFER_DEN = 2;
const RPC_TIMEOUT_MS = 20_000;

export interface CollectLeg {
  chain: string;
  status: string;
  walletsSwept: number;
  walletsSkipped: number;
  collectedG: string;
  forwardedG: string;
  leftoverNative: string;
  fundingTx: string | null;
  forwardTx: string | null;
  leftoverTx: string | null;
  sweepTxs: { wallet: string; tx?: string; amountG?: string; status?: string; reason?: string }[];
  error: string | null;
}

export interface CollectResult {
  startedAt: string;
  finishedAt: string;
  collectionId: string;
  collectionAddress: string;
  label: string;
  legs: CollectLeg[];
  dryRun: boolean;
}

let collecting = false;
let lastCollection: CollectResult | null = null;

export function isCollecting(): boolean {
  return collecting;
}
export function getLastCollection(): CollectResult | null {
  return lastCollection;
}

/* ---------------- providers & helpers ---------------- */

async function getProvider(chain: string): Promise<JsonRpcProvider> {
  const cfg = BALANCE_CHAINS[chain];
  if (!cfg) throw new Error(`unsupported chain: ${chain}`);
  let lastErr = '';
  for (const url of cfg.rpcs) {
    try {
      const p = new JsonRpcProvider(url, undefined, { staticNetwork: true });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
      try {
        await p.getBlockNumber();
        // Representative check: our real workload is eth_call (balanceOf). A node that
        // answers getBlockNumber but 413s eth_call (seen on XDC) must be skipped here.
        await p.call({ to: cfg.gdAddress, data: BALANCE_OF_SELECTOR + pad32(cfg.gdAddress) });
      } finally {
        clearTimeout(t);
      }
      return p;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`all RPCs failed for ${chain}: ${lastErr}`);
}

/** Transport-level RPC failures worth retrying on the next fallback RPC. */
function isRetryableRpcError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /413|429|502|503|504|timeout|timed out|abort|network|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|server response|bad gateway|service unavailable/i.test(m);
}

function pad32(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function transferData(to: string, amountWei: bigint): string {
  return ERC20_TRANSFER_SELECTOR + pad32(to) + pad32('0x' + amountWei.toString(16));
}

async function getRawBalances(
  provider: JsonRpcProvider,
  chain: string,
  address: string,
): Promise<{ nativeWei: bigint; gdWei: bigint }> {
  const cfg = BALANCE_CHAINS[chain];
  const data = BALANCE_OF_SELECTOR + pad32(address);
  const [nativeWei, gdHex] = await Promise.all([
    provider.getBalance(address),
    provider.call({ to: cfg.gdAddress, data }),
  ]);
  return { nativeWei, gdWei: BigInt(gdHex) };
}

async function estimateTransferCost(
  provider: JsonRpcProvider,
  chain: string,
  from: string,
  to: string,
  amountWei: bigint,
): Promise<{ gas: bigint; gasPrice: bigint; costWei: bigint }> {
  const cfg = BALANCE_CHAINS[chain];
  const gas = await provider.estimateGas({
    from,
    to: cfg.gdAddress,
    data: transferData(to, amountWei),
  });
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? parseUnits('1', 'gwei');
  return { gas, gasPrice, costWei: gas * gasPrice };
}

async function waitReceipt(tx: { hash: string; wait: (n?: number) => Promise<unknown> }): Promise<void> {
  try {
    await tx.wait(1);
  } catch {
    // receipt wait timed out — the tx may still confirm; balance checks later decide
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Supabase writes (collection tables only) ---------------- */

async function supaPost(table: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { url, key } = supaEnv();
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`supabase insert into ${table} failed: HTTP ${res.status}`);
  const rows = (await res.json()) as Record<string, unknown>[];
  return rows[0] ?? {};
}

async function supaPatch(table: string, id: string, body: Record<string, unknown>): Promise<void> {
  const { url, key } = supaEnv();
  const res = await fetch(`${url}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`supabase update ${table} failed: HTTP ${res.status}`);
}

/* ---------------- faucet (Celo only, verified) ---------------- */

async function fundViaFaucet(chain: string, address: string): Promise<boolean> {
  try {
    const res = await fetch(getGdClaimUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'fundGas', chain, address }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; httpStatus?: number };
    return res.status === 200 && data.ok !== false;
  } catch {
    return false;
  }
}

/* ---------------- one wallet sweep ---------------- */

interface SweepOutcome {
  wallet: string;
  status: 'swept' | 'skipped';
  tx?: string;
  amountG?: string;
  reason?: string;
}

async function sweepOneWallet(
  chain: string,
  w: WalletConfig & { address: string },
  collectionAddress: string,
  dustWei: bigint,
  main: { signer: Wallet; address: string },
  dryRun: boolean,
): Promise<SweepOutcome> {
  const cfg = BALANCE_CHAINS[chain];
  // READ phase with per-RPC fallback (no side effects — safe to retry).
  // A single sick RPC must not sink all wallets.
  let provider: JsonRpcProvider | null = null;
  let nativeWei = BigInt(0);
  let gdWei = BigInt(0);
  let costWei = BigInt(0);
  let lastErr: unknown = null;
  for (const url of cfg.rpcs) {
    try {
      const p = new JsonRpcProvider(url, undefined, { staticNetwork: true });
      const bal = await getRawBalances(p, chain, w.address);
      const est = await estimateTransferCost(p, chain, w.address, collectionAddress, bal.gdWei);
      provider = p;
      nativeWei = bal.nativeWei;
      gdWei = bal.gdWei;
      costWei = est.costWei;
      break;
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
    }
  }
  if (!provider) {
    return {
      wallet: w.label,
      status: 'skipped',
      reason: lastErr instanceof Error ? lastErr.message.slice(0, 160) : 'sweep failed',
    };
  }
  try {
    if (gdWei < dustWei) return { wallet: w.label, status: 'skipped', reason: 'dust' };

    if (dryRun) {
      // estimation only — no faucet, no funding, no broadcast
      const short = nativeWei < costWei;
      return {
        wallet: w.label,
        status: short ? 'skipped' : 'swept',
        amountG: gdWei.toString(),
        reason: `dry-run: sweep gas ~${costWei} wei, have ${nativeWei}${short ? ' — would need funding' : ''}`,
      };
    }
    // ensure gas for the sweep tx
    if (nativeWei < costWei) {
      if (chain === 'celo') {
        const ok = await fundViaFaucet(chain, w.address);
        if (ok) {
          await sleep(30_000);
          ({ nativeWei } = await getRawBalances(provider, chain, w.address));
        }
      } else if (chain === 'xdc') {
        // main funds the dry XDC wallet directly (faucet is CELO-only)
        const fundAmount = (costWei * BigInt(FUNDING_BUFFER_NUM)) / BigInt(FUNDING_BUFFER_DEN);
        const tx = await main.signer.sendTransaction({ to: w.address, value: fundAmount });
        await waitReceipt(tx);
        await sleep(5_000);
        ({ nativeWei } = await getRawBalances(provider, chain, w.address));
      }
      if (nativeWei < costWei) {
        return { wallet: w.label, status: 'skipped', reason: `low gas (have ${nativeWei}, need ~${costWei})` };
      }
    }

    const signer = new Wallet(w.privateKey, provider);
    const contract = new Contract(
      cfg.gdAddress,
      ['function transfer(address to, uint256 amount) returns (bool)'],
      signer,
    );
    const tx = await contract.transfer(collectionAddress, gdWei);
    await waitReceipt(tx);
    return { wallet: w.label, status: 'swept', tx: tx.hash, amountG: gdWei.toString() };
  } catch (e) {
    return { wallet: w.label, status: 'skipped', reason: e instanceof Error ? e.message.slice(0, 160) : 'sweep failed' };
  }
}

/* ---------------- one chain leg ---------------- */

async function runChainLeg(
  chain: string,
  collectionId: string,
  collectionAddress: string,
  collectionKey: string,
  wallets: (WalletConfig & { address: string })[],
  main: { signer: Wallet; address: string; privateKey: string },
  destination: string,
  dustWei: bigint,
  gdDecimals: number,
  dryRun: boolean,
): Promise<CollectLeg> {
  const cfg = BALANCE_CHAINS[chain];
  const legRow = await supaPost('collection_legs', { collection_id: collectionId, chain, status: 'sweeping' });
  const legId = String(legRow.id);
  const leg: CollectLeg = {
    chain,
    status: 'sweeping',
    walletsSwept: 0,
    walletsSkipped: 0,
    collectedG: '0',
    forwardedG: '0',
    leftoverNative: '0',
    fundingTx: null,
    forwardTx: null,
    leftoverTx: null,
    sweepTxs: [],
    error: null,
  };
  const save = () =>
    supaPatch('collection_legs', legId, {
      status: leg.status,
      wallets_swept: leg.walletsSwept,
      wallets_skipped: leg.walletsSkipped,
      collected_g: leg.collectedG,
      forwarded_g: leg.forwardedG,
      leftover_native: leg.leftoverNative,
      funding_tx: leg.fundingTx,
      forward_tx: leg.forwardTx,
      leftover_tx: leg.leftoverTx,
      sweep_txs: JSON.stringify(leg.sweepTxs),
      error: leg.error,
    }).catch((e) => console.error('leg save failed:', e instanceof Error ? e.message : e));

  try {
    const provider = await getProvider(chain);
    // sweeps: parallel across wallets (different signers — no nonce clash)
    const outcomes = await Promise.all(
      wallets.map((w) => sweepOneWallet(chain, w, collectionAddress, dustWei, main, dryRun)),
    );
    let collected = BigInt(0);
    for (const o of outcomes) {
      if (o.status === 'swept') {
        leg.walletsSwept++;
        collected += BigInt(o.amountG ?? '0');
        if (o.tx) leg.sweepTxs.push({ wallet: o.wallet, tx: o.tx, amountG: o.amountG ?? '0' });
      } else {
        leg.walletsSkipped++;
        // In dry-run mode, keep the skip reason so we can diagnose (e.g. RPC failures)
        if (dryRun) leg.sweepTxs.push({ wallet: o.wallet, status: o.status, reason: o.reason });
      }
    }
    leg.collectedG = collected.toString();
    await save();

    if (collected === BigInt(0)) {
      leg.status = 'completed';
      await save();
      return leg;
    }
    if (dryRun) {
      leg.status = 'completed';
      leg.error = 'dry-run: no funding/forwarding broadcast';
      await save();
      return leg;
    }

    // fund the collection wallet: (G$ forward + native sweep) × 1.5
    leg.status = 'funding';
    await save();
    const fee = await provider.getFeeData();
    const gasPrice = fee.gasPrice ?? parseUnits('1', 'gwei');
    const estTransfer = await provider.estimateGas({
      from: collectionAddress,
      to: cfg.gdAddress,
      data: transferData(destination, collected),
    });
    const estNativeSweep = BigInt(21000);
    const fundAmount =
      ((estTransfer + estNativeSweep) * gasPrice * BigInt(FUNDING_BUFFER_NUM)) / BigInt(FUNDING_BUFFER_DEN);
    const fundTx = await main.signer.sendTransaction({ to: collectionAddress, value: fundAmount });
    await waitReceipt(fundTx);
    leg.fundingTx = fundTx.hash;
    await save();

    // forward all G$ → destination
    leg.status = 'forwarding';
    await save();
    const collectionSigner = new Wallet(collectionKey, provider);
    const gdContract = new Contract(
      cfg.gdAddress,
      ['function transfer(address to, uint256 amount) returns (bool)'],
      collectionSigner,
    );
    const { gdWei } = await getRawBalances(provider, chain, collectionAddress);
    if (gdWei > BigInt(0)) {
      const fwdTx = await gdContract.transfer(destination, gdWei);
      await waitReceipt(fwdTx);
      leg.forwardTx = fwdTx.hash;
      leg.forwardedG = gdWei.toString();
    }
    await save();

    // sweep leftover native → destination (keep a small buffer for this tx's own gas)
    const { nativeWei } = await getRawBalances(provider, chain, collectionAddress);
    const keepBuffer = estNativeSweep * gasPrice * BigInt(12) / BigInt(10);
    if (nativeWei > keepBuffer * BigInt(2)) {
      const sendAmount = nativeWei - keepBuffer;
      const lvTx = await collectionSigner.sendTransaction({ to: destination, value: sendAmount });
      await waitReceipt(lvTx);
      leg.leftoverTx = lvTx.hash;
      leg.leftoverNative = sendAmount.toString();
    } else {
      leg.leftoverNative = '0';
    }

    leg.status = 'completed';
    await save();
    return leg;
  } catch (e) {
    leg.status = 'failed';
    leg.error = e instanceof Error ? e.message.slice(0, 300) : 'leg failed';
    await save();
    return leg;
  }
}

/* ---------------- full collection run ---------------- */

export async function runCollection(opts: { dryRun?: boolean } = {}): Promise<CollectResult> {
  const dryRun = opts.dryRun === true;
  if (collecting) {
    if (!lastCollection) throw new Error('a collection is already in progress');
    return lastCollection;
  }
  collecting = true;
  const startedAt = new Date().toISOString();
  let collectionId = '';
  try {
    const settings = await getCollectionSettings();
    if (!settings.mainWalletId) throw new Error('no main wallet configured (collection_settings.collection_main_wallet_id)');
    const enabledChains = settings.enabledChains.filter((c) => BALANCE_CHAINS[c]);
    if (enabledChains.length === 0) throw new Error('no enabled chains for collection');

    const all = await getWallets();
    const mainRow = all.find((w) => w.id === settings.mainWalletId);
    if (!mainRow || mainRow.loadError || !mainRow.privateKey)
      throw new Error('main wallet not found or cannot be decrypted');
    const mainAddress = addressFromPrivateKey(mainRow.privateKey);
    const destination =
      settings.destination && /^0x[0-9a-fA-F]{40}$/.test(settings.destination.trim())
        ? settings.destination.trim()
        : mainAddress;

    // eligible source wallets: decryptable, on at least one enabled chain
    const sources = all
      .filter((w) => !w.loadError && w.privateKey && w.chains.some((c) => enabledChains.includes(c)))
      .map((w) => ({ ...w, address: addressFromPrivateKey(w.privateKey) }));

    // 1. generate + SAVE the collection wallet before anything moves
    const collectionSignerKey = Wallet.createRandom();
    const collectionAddress = collectionSignerKey.address;
    const collectionKey = collectionSignerKey.privateKey.replace(/^0x/, '');
    const label = `Collection ${startedAt.slice(0, 16).replace('T', ' ')}${dryRun ? ' (dry-run)' : ''}`;
    const colRow = await supaPost('collection_wallets', {
      label,
      encrypted_key: encryptPrivateKey(collectionKey),
      address: collectionAddress,
      status: 'collecting',
    });
    collectionId = String(colRow.id);
    // 2. run each chain leg (parallel across chains — independent networks/nonces)
    const legs = await Promise.all(
      enabledChains.map(async (chain) => {
        const gdDecimals = BALANCE_CHAINS[chain].gdDecimals;
        const dustWei = parseUnits(settings.dustG || '0.01', gdDecimals);
        const chainWallets = sources.filter((w) => w.chains.includes(chain));
        // main signer is per-chain (provider-bound) — created inside the leg via mainRow
        const provider = await getProvider(chain);
        const mainSigner = new Wallet(mainRow.privateKey, provider);
        return runChainLeg(
          chain,
          collectionId,
          collectionAddress,
          collectionKey,
          chainWallets,
          { signer: mainSigner, address: mainAddress, privateKey: mainRow.privateKey },
          destination,
          dustWei,
          gdDecimals,
          dryRun,
        );
      }),
    );

    const failed = legs.some((l) => l.status === 'failed');
    await supaPatch('collection_wallets', collectionId, {
      status: failed ? 'failed' : 'completed',
      error: failed ? legs.find((l) => l.error)?.error ?? 'a leg failed' : null,
    });
    if (!dryRun) await setSetting('collection_last_run_at', new Date().toISOString());

    const finishedAt = new Date().toISOString();
    lastCollection = { startedAt, finishedAt, collectionId, collectionAddress, label, legs, dryRun };
    // alert on failures (never breaks the run)
    if (!dryRun && failed) {
      try {
        await alertCollectionFinished({
          label,
          collectionAddress,
          legs: legs.map((l) => ({
            chain: l.chain,
            status: l.status,
            walletsSwept: l.walletsSwept,
            walletsSkipped: l.walletsSkipped,
            collectedG: l.collectedG,
            forwardedG: l.forwardedG,
            forwardTx: l.forwardTx,
            error: l.error,
          })),
        });
      } catch (e) {
        console.error('collection alert failed:', e instanceof Error ? e.message : e);
      }
    }
    return lastCollection;
  } catch (e) {
    // whole collection crashed before completing — mark the row failed (never leave it stuck
    // in 'collecting') and alert (keys already in DB)
    if (collectionId) {
      await supaPatch('collection_wallets', collectionId, {
        status: 'failed',
        error: `collection crashed: ${e instanceof Error ? e.message.slice(0, 300) : 'unknown'}`,
      }).catch(() => {});
    }
    if (!dryRun) {
      try {
        await alertCollectionFinished({
          label: `Collection ${startedAt.slice(0, 16).replace('T', ' ')}`,
          collectionAddress: '',
          legs: [
            {
              chain: '-',
              status: 'failed',
              walletsSwept: 0,
              walletsSkipped: 0,
              collectedG: '0',
              forwardedG: '0',
              forwardTx: null,
              error: e instanceof Error ? e.message.slice(0, 300) : 'collection crashed',
            },
          ],
        });
      } catch (ae) {
        console.error('collection crash alert failed:', ae instanceof Error ? ae.message : ae);
      }
    }
    throw e;
  } finally {
    collecting = false;
  }
}

/** Auto-trigger check: run after the 22:00 UTC claim run when ≥3 days passed.
 *  Never throws — collection must not break claims. */
export async function maybeAutoCollect(dueSlotKeys: string[]): Promise<void> {
  try {
    if (!dueSlotKeys.includes('22:00')) return;
    const settings = await getCollectionSettings();
    if (!settings.auto) return;
    if (collecting) return;
    const last = settings.lastRunAt ? new Date(settings.lastRunAt).getTime() : 0;
    if (Date.now() - last < 3 * 24 * 3600_000) return;
    console.log('collect: auto-triggering 3-day collection');
    await runCollection();
  } catch (e) {
    console.error('collect: auto-trigger failed:', e instanceof Error ? e.message : e);
  }
}
