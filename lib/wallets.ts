// Wallet source: Supabase `claim_wallets` table (see supabase.sql).
// Only CIPHERTEXT ever leaves the database. Each key is decrypted in server
// memory at claim time using PROJECT_KEY — never logged, never sent to clients.
//
// Removal is SOFT since Nov 2026: deleteWallet sets deleted_at instead of
// deleting the row, so a removed wallet (and its encrypted key) stays
// recoverable via restoreWallet. Reads only return active rows. The
// deleted_at column is additive — rows created before it existed read as
// active. If the column is ever missing (migration not applied), reads
// fall back to the unfiltered query so the vault keeps working.

import { Wallet } from 'ethers';
import { canDecrypt, decryptPrivateKey, encryptPrivateKey } from './crypto';

/** Derive the 0x address from a private key (same address on Celo/XDC/Fuse). */
export function addressFromPrivateKey(privateKey: string): string {
  const pk = privateKey.trim().startsWith('0x') ? privateKey.trim() : `0x${privateKey.trim()}`;
  return new Wallet(pk).address;
}

export interface WalletConfig {
  id: string;
  label: string;
  privateKey: string;
  chains: string[];
  /** Set when this row's key can't be decrypted — the wallet fails on its own, never blocking others. */
  loadError?: string;
}

export interface WalletInfo {
  id: string;
  label: string;
  chains: string[];
  keyOk: boolean; // decrypts to a key-shaped value (checked server-side, never exposed)
  /** Derived from the key once at insert; null until backfilled for older rows. */
  address: string | null;
}

export interface DeletedWalletInfo extends WalletInfo {
  deletedAt: string | null;
}

export interface VaultBackupEntry {
  id: string;
  label: string;
  chains: string;
  address: string | null;
  /** AES-256-GCM ciphertext — decryptable only with PROJECT_KEY. */
  encrypted_key: string;
  deleted_at: string | null;
  created_at: string | null;
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

export function supaEnv(): { url: string; key: string } {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set');
  if (!process.env.PROJECT_KEY) throw new Error('PROJECT_KEY is not set');
  return { url, key };
}

const SUPA_TIMEOUT_MS = 30_000;

interface SupaRow {
  id: string;
  label: string;
  encrypted_key: string;
  chains: string;
  address: string | null;
  deleted_at?: string | null;
}

async function fetchRows(): Promise<SupaRow[]> {
  const { url, key } = supaEnv();
  const base = `${url}/rest/v1/claim_wallets?select=id,label,encrypted_key,chains,address,deleted_at&order=created_at`;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  // Prefer the deleted-aware query; fall back to the legacy query if the
  // deleted_at column doesn't exist yet (migration not applied).
  let res = await fetch(`${base}&deleted_at=is.null`, {
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
  });
  if (res.status === 400) {
    res = await fetch(base, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    });
  }
  if (res.status === 404)
    throw new Error('claim_wallets table not found — run supabase.sql in the Supabase SQL editor once');
  if (!res.ok) throw new Error(`Supabase read failed: HTTP ${res.status}`);
  const rows = (await res.json()) as SupaRow[];
  return rows.filter((r) => !r.deleted_at);
}

function toChains(raw: string, fallback: string[]): string[] {
  const list = (raw || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : fallback;
}

/** Full wallet configs with DECRYPTED keys — call only when actually running claims.
 *  A row that fails to decrypt does NOT throw: it's returned with loadError so
 *  one bad row can never take the whole run down. */
export async function getWallets(): Promise<WalletConfig[]> {
  const rows = await fetchRows();
  const fallback = getChains();
  return rows.map((r, i) => {
    const label = r.label || `Wallet ${i + 1}`;
    const chains = toChains(r.chains, fallback);
    try {
      return { id: r.id, label, privateKey: decryptPrivateKey(r.encrypted_key).trim(), chains };
    } catch {
      return {
        id: r.id,
        label,
        privateKey: '',
        chains,
        loadError: 'cannot decrypt: wrong PROJECT_KEY or corrupted key',
      };
    }
  });
}

/** Safe metadata for the dashboard — ids/labels/chains/addresses only, plus a decrypt health check. */
export async function listWallets(): Promise<WalletInfo[]> {
  const rows = await fetchRows();
  const fallback = getChains();
  return rows.map((r, i) => ({
    id: r.id,
    label: r.label || `Wallet ${i + 1}`,
    chains: toChains(r.chains, fallback),
    keyOk: canDecrypt(r.encrypted_key),
    address: r.address || null,
  }));
}

/** One-time backfill: derive and store the address for rows added before the
 *  address column existed. Only UPDATEs the address column — keys are never
 *  touched. Safe to call on every balance check; rows already filled are skipped. */
export async function ensureAddresses(): Promise<number> {
  const rows = await fetchRows();
  const missing = rows.filter((r) => !r.address);
  if (missing.length === 0) return 0;
  const { url, key } = supaEnv();
  let filled = 0;
  await Promise.all(
    missing.map(async (r) => {
      try {
        const address = addressFromPrivateKey(decryptPrivateKey(r.encrypted_key));
        const res = await fetch(`${url}/rest/v1/claim_wallets?id=eq.${encodeURIComponent(r.id)}`, {
          method: 'PATCH',
          headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
          body: JSON.stringify({ address }),
        });
        if (res.ok) filled++;
        else console.error(`ensureAddresses: failed for ${r.label}: HTTP ${res.status}`);
      } catch (e) {
        console.error(`ensureAddresses: cannot derive for ${r.label}:`, e instanceof Error ? e.message : e);
      }
    }),
  );
  return filled;
}

async function fetchActiveLabels(): Promise<string[]> {
  const { url, key } = supaEnv();
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const base = `${url}/rest/v1/claim_wallets?select=label,deleted_at`;
  let res = await fetch(`${base}&deleted_at=is.null`, {
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
  });
  if (res.status === 400) {
    res = await fetch(base, { headers, cache: 'no-store', signal: AbortSignal.timeout(SUPA_TIMEOUT_MS) });
  }
  if (!res.ok) return [];
  const rows = (await res.json()) as { label: string; deleted_at?: string | null }[];
  return rows.filter((r) => !r.deleted_at).map((r) => r.label);
}

/** Encrypt + store a new wallet. Key format is validated; never stored raw.
 *  Returns the new row id. */
export async function addWallet(input: { label: string; privateKey: string; chains: string[] }): Promise<string> {
  const label = (input.label || '').trim();
  const pk = (input.privateKey || '').trim();
  if (!label) throw new Error('wallet name is required');
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) throw new Error('private key must be 64 hex characters');
  const chains = (input.chains || []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (chains.length === 0) throw new Error('select at least one chain');
  const { url, key } = supaEnv();
  // Reject duplicate names among ACTIVE wallets (case-insensitive) so the
  // dashboard stays unambiguous. A removed wallet's name can be reused.
  const existing = await fetchActiveLabels();
  if (existing.some((l) => l.toLowerCase() === label.toLowerCase())) {
    throw new Error(`a wallet named "${label}" already exists`);
  }
  const res = await fetch(`${url}/rest/v1/claim_wallets`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    body: JSON.stringify({
      label,
      encrypted_key: encryptPrivateKey(pk),
      chains: chains.join(','),
      address: addressFromPrivateKey(pk),
    }),
  });
  if (res.status === 404)
    throw new Error('claim_wallets table not found — run supabase.sql in the Supabase SQL editor once');
  if (!res.ok) throw new Error(`Supabase insert failed: HTTP ${res.status}`);
  const rows = (await res.json().catch(() => [])) as { id?: string }[];
  return rows?.[0]?.id ?? '';
}

/** Soft-remove a wallet from the vault: sets deleted_at, keeps the row
 *  (and its encrypted key) for restore. Returns the wallet label for audit. */
export async function deleteWallet(id: string): Promise<string> {
  if (!id) throw new Error('wallet id is required');
  const { url, key } = supaEnv();
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  let label = '';
  try {
    const lookup = await fetch(`${url}/rest/v1/claim_wallets?id=eq.${encodeURIComponent(id)}&select=label`, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    });
    if (lookup.ok) {
      const rows = (await lookup.json()) as { label: string }[];
      label = rows?.[0]?.label ?? '';
    }
  } catch {
    /* label lookup is best-effort; the delete still proceeds */
  }
  const res = await fetch(`${url}/rest/v1/claim_wallets?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase remove failed: HTTP ${res.status}`);
  return label;
}

/** Restore a soft-removed wallet. Returns its label for audit. */
export async function restoreWallet(id: string): Promise<string> {
  if (!id) throw new Error('wallet id is required');
  const { url, key } = supaEnv();
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  let label = '';
  try {
    const lookup = await fetch(`${url}/rest/v1/claim_wallets?id=eq.${encodeURIComponent(id)}&select=label`, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    });
    if (lookup.ok) {
      const rows = (await lookup.json()) as { label: string }[];
      label = rows?.[0]?.label ?? '';
    }
  } catch {
    /* label lookup is best-effort */
  }
  const res = await fetch(`${url}/rest/v1/claim_wallets?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    body: JSON.stringify({ deleted_at: null }),
  });
  if (!res.ok) throw new Error(`Supabase restore failed: HTTP ${res.status}`);
  return label;
}

/** Removed wallets (metadata only — keys never leave the vault). */
export async function listDeletedWallets(): Promise<DeletedWalletInfo[]> {
  const { url, key } = supaEnv();
  const res = await fetch(
    `${url}/rest/v1/claim_wallets?select=id,label,encrypted_key,chains,address,deleted_at&deleted_at=not.is.null&order=deleted_at.desc`,
    {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    },
  );
  if (res.status === 400) return []; // column missing: nothing was ever soft-deleted
  if (!res.ok) throw new Error(`Supabase read failed: HTTP ${res.status}`);
  const rows = (await res.json()) as SupaRow[];
  const fallback = getChains();
  return rows.map((r, i) => ({
    id: r.id,
    label: r.label || `Wallet ${i + 1}`,
    chains: toChains(r.chains, fallback),
    keyOk: canDecrypt(r.encrypted_key),
    address: r.address || null,
    deletedAt: r.deleted_at ?? null,
  }));
}

/**
 * Encrypted vault backup: ciphertext rows only (admin-only endpoint).
 * Useless without PROJECT_KEY — which is exactly the point: the backup
 * can be stored offline safely, and restoring needs the key + this file.
 */
export async function getVaultBackup(): Promise<VaultBackupEntry[]> {
  const { url, key } = supaEnv();
  const res = await fetch(
    `${url}/rest/v1/claim_wallets?select=id,label,encrypted_key,chains,address,deleted_at,created_at&order=created_at`,
    {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Supabase read failed: HTTP ${res.status}`);
  return (await res.json()) as VaultBackupEntry[];
}

export function isDbConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY && process.env.PROJECT_KEY);
}
