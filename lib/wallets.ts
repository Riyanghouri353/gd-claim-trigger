// Wallet source: Supabase `claim_wallets` table (see supabase.sql).
// Only CIPHERTEXT ever leaves the database. Each key is decrypted in server
// memory at claim time using PROJECT_KEY — never logged, never sent to clients.

import { canDecrypt, decryptPrivateKey } from './crypto';

export interface WalletConfig {
  label: string;
  privateKey: string;
  chains: string[];
}

export interface WalletInfo {
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
  label: string;
  encrypted_key: string;
  chains: string;
}

async function fetchRows(): Promise<SupaRow[]> {
  const { url, key } = supaEnv();
  const res = await fetch(`${url}/rest/v1/claim_wallets?select=label,encrypted_key,chains&order=created_at`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
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

/** Safe metadata for the dashboard — labels/chains only, plus a decrypt health check. */
export async function listWallets(): Promise<WalletInfo[]> {
  const rows = await fetchRows();
  const fallback = getChains();
  return rows.map((r, i) => ({
    label: r.label || `Wallet ${i + 1}`,
    chains: toChains(r.chains, fallback),
    keyOk: canDecrypt(r.encrypted_key),
  }));
}

export function isDbConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY && process.env.PROJECT_KEY);
}
