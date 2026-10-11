// Wallet source: Supabase `claim_wallets` table (see supabase.sql).
// Only CIPHERTEXT ever leaves the database. Each key is decrypted in server
// memory at claim time using PROJECT_KEY — never logged, never sent to clients.

import { canDecrypt, decryptPrivateKey, encryptPrivateKey } from './crypto';

export interface WalletConfig {
  label: string;
  privateKey: string;
  chains: string[];
}

export interface WalletInfo {
  id: string;
  label: string;
  chains: string[];
  keyOk: boolean; // decrypts to a key-shaped value (checked server-side, never exposed)
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

function supaEnv(): { url: string; key: string } {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set');
  if (!process.env.PROJECT_KEY) throw new Error('PROJECT_KEY is not set');
  return { url, key };
}

interface SupaRow {
  id: string;
  label: string;
  encrypted_key: string;
  chains: string;
}

async function fetchRows(): Promise<SupaRow[]> {
  const { url, key } = supaEnv();
  const res = await fetch(`${url}/rest/v1/claim_wallets?select=id,label,encrypted_key,chains&order=created_at`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: 'no-store',
  });
  if (res.status === 404)
    throw new Error('claim_wallets table not found — run supabase.sql in the Supabase SQL editor once');
  if (!res.ok) throw new Error(`Supabase read failed: HTTP ${res.status}`);
  return (await res.json()) as SupaRow[];
}

function toChains(raw: string, fallback: string[]): string[] {
  const list = (raw || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : fallback;
}

/** Full wallet configs with DECRYPTED keys — call only when actually running claims. */
export async function getWallets(): Promise<WalletConfig[]> {
  const rows = await fetchRows();
  const fallback = getChains();
  return rows.map((r, i) => {
    let privateKey: string;
    try {
      privateKey = decryptPrivateKey(r.encrypted_key).trim();
    } catch {
      throw new Error(`cannot decrypt key for "${r.label || `wallet ${i + 1}`}": wrong PROJECT_KEY?`);
    }
    return {
      label: r.label || `Wallet ${i + 1}`,
      privateKey,
      chains: toChains(r.chains, fallback),
    };
  });
}

/** Safe metadata for the dashboard — ids/labels/chains only, plus a decrypt health check. */
export async function listWallets(): Promise<WalletInfo[]> {
  const rows = await fetchRows();
  const fallback = getChains();
  return rows.map((r, i) => ({
    id: r.id,
    label: r.label || `Wallet ${i + 1}`,
    chains: toChains(r.chains, fallback),
    keyOk: canDecrypt(r.encrypted_key),
  }));
}

/** Encrypt + store a new wallet. Key format is validated; never stored raw. */
export async function addWallet(input: { label: string; privateKey: string; chains: string[] }): Promise<void> {
  const label = (input.label || '').trim();
  const pk = (input.privateKey || '').trim();
  if (!label) throw new Error('wallet name is required');
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) throw new Error('private key must be 64 hex characters');
  const chains = (input.chains || []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (chains.length === 0) throw new Error('select at least one chain');
  const { url, key } = supaEnv();
  const res = await fetch(`${url}/rest/v1/claim_wallets`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify({ label, encrypted_key: encryptPrivateKey(pk), chains: chains.join(',') }),
  });
  if (res.status === 404)
    throw new Error('claim_wallets table not found — run supabase.sql in the Supabase SQL editor once');
  if (!res.ok) throw new Error(`Supabase insert failed: HTTP ${res.status}`);
}

/** Remove a wallet from the vault. */
export async function deleteWallet(id: string): Promise<void> {
  if (!id) throw new Error('wallet id is required');
  const { url, key } = supaEnv();
  const res = await fetch(`${url}/rest/v1/claim_wallets?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Supabase delete failed: HTTP ${res.status}`);
}

export function isDbConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY && process.env.PROJECT_KEY);
}
