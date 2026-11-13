// Minimal Supabase REST helper shared by the claim-runner tables
// (history, slots, audit, alert state). Uses the same service_role env
// config as lib/wallets.ts. All calls carry a timeout; callers decide
// whether a failure is fatal (wallet reads) or best-effort (history/audit).

import { supaEnv } from './wallets';

const SUPA_TIMEOUT_MS = 30_000;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const { key } = supaEnv();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

export async function supaGet<T>(path: string): Promise<T> {
  const { url } = supaEnv();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: headers(),
    cache: 'no-store',
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Supabase GET ${path.split('?')[0]} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** POST rows; with `returning`, PostgREST returns the inserted rows. */
export async function supaPost<T>(
  table: string,
  body: unknown,
  opts: { returning?: boolean; upsert?: boolean } = {},
): Promise<T> {
  const { url } = supaEnv();
  const prefer: string[] = [];
  if (opts.returning) prefer.push('return=representation');
  if (opts.upsert) prefer.push('resolution=merge-duplicates');
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({
      'Content-Type': 'application/json',
      ...(prefer.length > 0 ? { Prefer: prefer.join(',') } : {}),
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${table} failed: HTTP ${res.status}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export async function supaPatch(table: string, filter: string, body: unknown): Promise<void> {
  const { url } = supaEnv();
  const res = await fetch(`${url}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: headers({ 'Content-Type': 'application/json' }),
    cache: 'no-store',
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} failed: HTTP ${res.status}`);
}

export async function supaDelete(table: string, filter: string): Promise<void> {
  const { url } = supaEnv();
  const res = await fetch(`${url}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: headers(),
    cache: 'no-store',
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Supabase DELETE ${table} failed: HTTP ${res.status}`);
}
