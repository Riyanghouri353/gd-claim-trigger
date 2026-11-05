// Wallet key recovery engine — Riyan lost the last digit(s) of one of his own
// EVM private keys. He supplies the known part as a 64-char template with '?'
// for each unknown hex digit; the engine enumerates every combination
// (16^n), derives each address, and checks its USDT (BEP20, BSC) balance.
// Any candidate with balance >= threshold is a HIT: its full private key is
// stored AES-256-GCM ENCRYPTED (lib/crypto.ts, PROJECT_KEY) in the Supabase
// `recovery_hits` table. Plaintext keys exist only in server memory during
// the scan and in the explicit reveal call the owner makes from the UI.
//
// SPEED DESIGN (measured 2026-11-05, see tests/recovery.test.mjs):
// - Derivation is incremental when the unknown digits are the suffix (the
//   lost-last-digits case): one full scalar multiplication, then each next
//   candidate is a single EC point addition of G (~14k derivations/sec).
//   Non-suffix templates fall back to a full multiplication per candidate
//   (~2.5k/sec). Either way derivation outruns the network.
// - Balance checks use JSON-RPC BATCH eth_call requests (100 calls per HTTP
//   request) against a pool of public BSC endpoints, 6 requests in parallel
//   with per-endpoint cooldown on errors. Single-endpoint batch-100 rates
//   measured 200–2,700/sec; the pool exists to sustain >=200 checks/sec.
// - The loop runs in the long-lived Render Node process (globalThis
//   singleton), NOT in a request handler, so it runs every second until the
//   owner stops it, the space is exhausted, or the process restarts (jobs
//   persist in Supabase and can be resumed from the UI).
//
// This module is fully separate from the G$ claim runner and the agent:
// it touches no claim/agent tables, files, or schedules.

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { encryptPrivateKey, decryptPrivateKey } from './crypto';

const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'; // 18 decimals on BSC
const BALANCE_OF = '0x70a08231';
const CHUNK = 100; // eth_call entries per JSON-RPC batch request
const CONCURRENCY = 6; // parallel batch requests per round
const MAX_UNKNOWN = 8; // 16^8 = 4.29B — hard cap, UI warns long before this

export const BSC_RPCS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc.drpc.org',
  'https://binance.llamarpc.com',
  'https://bsc.publicnode.com',
  'https://bsc-mainnet.public.blastapi.io',
  'https://1rpc.io/bnb',
];

// ---------------------------------------------------------------------------
// Template + candidate math
// ---------------------------------------------------------------------------

export interface TemplateInfo {
  template: string; // normalized: lowercase, no 0x, 64 chars, '?' = unknown
  unknownPositions: number[];
  total: bigint;
  suffixContiguous: boolean;
}

export function parseTemplate(raw: string): TemplateInfo {
  const t = (raw || '').trim().toLowerCase().replace(/^0x/, '').replace(/\s+/g, '');
  if (t.length !== 64) throw new Error(`template must be exactly 64 hex/? characters, got ${t.length}`);
  if (!/^[0-9a-f?]{64}$/.test(t)) throw new Error('template may only contain hex digits 0-9a-f and ? for unknown digits');
  const unknownPositions: number[] = [];
  for (let i = 0; i < 64; i++) if (t[i] === '?') unknownPositions.push(i);
  if (unknownPositions.length === 0) throw new Error('no unknown digits — nothing to recover; mark each lost digit with ?');
  if (unknownPositions.length > MAX_UNKNOWN)
    throw new Error(`too many unknown digits (${unknownPositions.length}); max is ${MAX_UNKNOWN} — beyond that the search space is not finishable`);
  const suffixContiguous = unknownPositions.every((p, i) => p === 64 - unknownPositions.length + i);
  return { template: t, unknownPositions, total: BigInt(16 ** unknownPositions.length), suffixContiguous };
}

/** Fill the '?' positions of a template with the base-16 digits of `index`. */
export function candidateKey(info: TemplateInfo, index: bigint): string {
  const chars = info.template.split('');
  let v = index;
  for (let k = info.unknownPositions.length - 1; k >= 0; k--) {
    chars[info.unknownPositions[k]] = (v & BigInt(15)).toString(16);
    v >>= BigInt(4);
  }
  return chars.join('');
}

// ---------------------------------------------------------------------------
// Address derivation (secp256k1 + keccak256)
// ---------------------------------------------------------------------------

function pointToAddress(x: bigint, y: bigint): string {
  const buf = new Uint8Array(64);
  const xb = x.toString(16).padStart(64, '0');
  const yb = y.toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) {
    buf[i] = parseInt(xb.slice(i * 2, i * 2 + 2), 16);
    buf[32 + i] = parseInt(yb.slice(i * 2, i * 2 + 2), 16);
  }
  const h = keccak_256(buf);
  let addr = '0x';
  for (let i = 12; i < 32; i++) addr += h[i].toString(16).padStart(2, '0');
  return addr;
}

export function addressFromKeyHex(keyHex: string): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16);
  const pub = secp256k1.getPublicKey(bytes, false).slice(1);
  const h = keccak_256(pub);
  let addr = '0x';
  for (let i = 12; i < 32; i++) addr += h[i].toString(16).padStart(2, '0');
  return addr;
}

interface Candidate {
  index: bigint;
  keyHex: string;
  address: string;
}

/** Derive `count` candidates starting at `start`. Uses single point additions
 *  when the unknowns are the key's suffix; full multiplications otherwise. */
export function deriveBatch(info: TemplateInfo, start: bigint, count: number): Candidate[] {
  const out: Candidate[] = [];
  const CURVE_N = secp256k1.CURVE.n;
  if (info.suffixContiguous) {
    const baseKey = candidateKey(info, start); // == private key value for `start`
    const basePriv = BigInt('0x' + baseKey);
    // Start point for this batch: one full multiplication, then +G steps.
    let pt =
      basePriv === BigInt(0)
        ? secp256k1.ProjectivePoint.ZERO
        : secp256k1.ProjectivePoint.BASE.multiply(basePriv % CURVE_N);
    for (let i = 0; i < count; i++) {
      const idx = start + BigInt(i);
      const keyHex = candidateKey(info, idx);
      const priv = BigInt('0x' + keyHex);
      if (priv === BigInt(0) || priv >= CURVE_N) {
        out.push({ index: idx, keyHex, address: '' }); // invalid key — never a wallet, balance treated as 0
      } else {
        if (i > 0) pt = pt.add(secp256k1.ProjectivePoint.BASE);
        const a = pt.toAffine();
        out.push({ index: idx, keyHex, address: pointToAddress(a.x, a.y) });
      }
      if (i === 0 && basePriv !== BigInt(0)) {
        // pt already equals basePriv*G; subsequent iterations add G. No-op.
      }
    }
    return out;
  }
  for (let i = 0; i < count; i++) {
    const idx = start + BigInt(i);
    const keyHex = candidateKey(info, idx);
    const priv = BigInt('0x' + keyHex);
    if (priv === BigInt(0) || priv >= CURVE_N) out.push({ index: idx, keyHex, address: '' });
    else out.push({ index: idx, keyHex, address: addressFromKeyHex(keyHex) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// BSC USDT balance checks — JSON-RPC batch eth_call over an endpoint pool
// ---------------------------------------------------------------------------

interface EndpointState {
  url: string;
  cooldownUntil: number;
  failures: number;
}

const endpoints: EndpointState[] = BSC_RPCS.map((url) => ({ url, cooldownUntil: 0, failures: 0 }));
let rpcCursor = 0;

function pickEndpoint(): EndpointState | null {
  const now = Date.now();
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[(rpcCursor + i) % endpoints.length];
    if (ep.cooldownUntil <= now) {
      rpcCursor = (rpcCursor + i + 1) % endpoints.length;
      return ep;
    }
  }
  return null;
}

/** Returns balances (raw 18-dec units) aligned with `addresses`, or null if
 *  every endpoint failed this chunk (caller retries the chunk). */
async function checkChunk(addresses: string[]): Promise<bigint[] | null> {
  const body = addresses.map((a, i) => ({
    jsonrpc: '2.0',
    id: i,
    method: 'eth_call',
    params: [{ to: USDT_BSC, data: BALANCE_OF + '000000000000000000000000' + a.slice(2) }, 'latest'],
  }));
  // Try up to 3 different endpoints for this chunk before giving up on it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const ep = pickEndpoint();
    if (!ep) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Array<{ id: number; result?: string; error?: { message: string } }>;
      if (!Array.isArray(json)) throw new Error('batch not supported by endpoint');
      const byId = new Map(json.map((r) => [r.id, r]));
      const out: bigint[] = [];
      for (let i = 0; i < addresses.length; i++) {
        const r = byId.get(i);
        if (!r || r.error || typeof r.result !== 'string') throw new Error('incomplete batch result');
        out.push(BigInt(r.result));
      }
      ep.failures = 0;
      return out;
    } catch (e) {
      ep.failures++;
      ep.cooldownUntil = Date.now() + Math.min(60000, 5000 * ep.failures);
      engine.lastError = `${ep.url}: ${e instanceof Error ? e.message : 'rpc error'}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Supabase persistence (service_role; RLS on, no public policies)
// ---------------------------------------------------------------------------

function supaEnv(): { url: string; key: string } {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set');
  return { url, key };
}

async function supa(path: string, init: RequestInit): Promise<Response> {
  const { url, key } = supaEnv();
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: ['Bearer', key].join(' '), 'content-type': 'application/json', ...(init.headers || {}) },
    cache: 'no-store',
  });
}

export interface RecoveryJobRow {
  id: string;
  unknown_count: number;
  total_combinations: string;
  threshold_usdt: string;
  checked_count: string;
  found_count: number;
  rate_per_sec: string;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecoveryHitRow {
  id: string;
  job_id: string | null;
  address: string;
  usdt_balance: string;
  created_at: string;
}

export async function listJobs(): Promise<RecoveryJobRow[]> {
  const res = await supa('recovery_jobs?select=id,unknown_count,total_combinations,threshold_usdt,checked_count,found_count,rate_per_sec,status,last_error,created_at,updated_at&order=created_at.desc&limit=20', { method: 'GET' });
  if (res.status === 404) throw new Error('recovery_jobs table not found — run supabase-recovery.sql once');
  if (!res.ok) throw new Error(`Supabase read failed: HTTP ${res.status}`);
  return (await res.json()) as RecoveryJobRow[];
}

export async function listHits(): Promise<RecoveryHitRow[]> {
  const res = await supa('recovery_hits?select=id,job_id,address,usdt_balance,created_at&order=created_at.desc&limit=100', { method: 'GET' });
  if (res.status === 404) throw new Error('recovery_hits table not found — run supabase-recovery.sql once');
  if (!res.ok) throw new Error(`Supabase read failed: HTTP ${res.status}`);
  return (await res.json()) as RecoveryHitRow[];
}

/** Decrypt one saved hit's key — called ONLY by the explicit reveal action. */
export async function revealHitKey(hitId: string): Promise<{ address: string; privateKey: string; usdtBalance: string }> {
  const res = await supa(`recovery_hits?select=address,encrypted_key,usdt_balance&id=eq.${encodeURIComponent(hitId)}`, { method: 'GET' });
  if (!res.ok) throw new Error(`Supabase read failed: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ address: string; encrypted_key: string; usdt_balance: string }>;
  if (!rows[0]) throw new Error('hit not found');
  return { address: rows[0].address, privateKey: decryptPrivateKey(rows[0].encrypted_key), usdtBalance: rows[0].usdt_balance };
}

async function createJobRow(info: TemplateInfo, thresholdUsdt: number, startAt: bigint): Promise<string> {
  const res = await supa('recovery_jobs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      encrypted_template: encryptPrivateKey(info.template),
      unknown_count: info.unknownPositions.length,
      total_combinations: info.total.toString(),
      threshold_usdt: thresholdUsdt,
      checked_count: startAt.toString(),
      status: 'running',
    }),
  });
  if (!res.ok) throw new Error(`could not create job row: HTTP ${res.status} — run supabase-recovery.sql if the table is missing`);
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows[0].id;
}

async function patchJobRow(id: string, patch: Record<string, unknown>): Promise<void> {
  await supa(`recovery_jobs?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

async function saveHit(jobId: string, address: string, keyHex: string, rawBalance: bigint): Promise<void> {
  const balanceUsdt = Number(rawBalance) / 1e18;
  const res = await supa('recovery_hits', {
    method: 'POST',
    body: JSON.stringify({ job_id: jobId, address, encrypted_key: encryptPrivateKey(keyHex), usdt_balance: balanceUsdt }),
  });
  if (!res.ok) throw new Error(`hit save failed: HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Engine — one scan at a time, runs until stopped / done / process restart
// ---------------------------------------------------------------------------

export interface EngineSnapshot {
  running: boolean;
  jobId: string | null;
  total: string;
  checked: string;
  found: number;
  ratePerSec: number;
  startedAt: string | null;
  lastError: string | null;
  thresholdUsdt: number;
  unknownCount: number;
  suffixFastPath: boolean;
}

interface EngineState extends EngineSnapshot {
  stopRequested: boolean;
  info: TemplateInfo | null;
  nextIndex: bigint;
  checkedCount: bigint;
  totalBig: bigint;
  thresholdRaw: bigint;
  recentChecks: number[]; // timestamps (ms) of recently verified candidates, for rate
  lastPersistAt: number;
}

const g = globalThis as unknown as { __recoveryEngine?: EngineState };
const engine: EngineState =
  g.__recoveryEngine ||
  (g.__recoveryEngine = {
    running: false,
    stopRequested: false,
    jobId: null,
    info: null,
    nextIndex: BigInt(0),
    checkedCount: BigInt(0),
    totalBig: BigInt(0),
    thresholdRaw: BigInt(0),
    total: '0',
    checked: '0',
    found: 0,
    ratePerSec: 0,
    startedAt: null,
    lastError: null,
    thresholdUsdt: 0.1,
    unknownCount: 0,
    suffixFastPath: false,
    recentChecks: [],
    lastPersistAt: 0,
  });

export function engineSnapshot(): EngineSnapshot {
  const cutoff = Date.now() - 10000;
  engine.recentChecks = engine.recentChecks.filter((t) => t >= cutoff);
  engine.ratePerSec = engine.running ? Math.round((engine.recentChecks.length / 10) * 10) / 10 : engine.ratePerSec;
  return {
    running: engine.running,
    jobId: engine.jobId,
    total: engine.totalBig.toString(),
    checked: engine.checkedCount.toString(),
    found: engine.found,
    ratePerSec: engine.ratePerSec,
    startedAt: engine.startedAt,
    lastError: engine.lastError,
    thresholdUsdt: engine.thresholdUsdt,
    unknownCount: engine.unknownCount,
    suffixFastPath: engine.suffixFastPath,
  };
}

export async function startScan(rawTemplate: string, thresholdUsdt: number, resume?: { jobId: string; startAt: bigint }): Promise<EngineSnapshot> {
  if (engine.running) throw new Error('a scan is already running — stop it first');
  const info = parseTemplate(rawTemplate);
  if (!(thresholdUsdt > 0)) throw new Error('threshold must be > 0');
  const startAt = resume ? resume.startAt : BigInt(0);
  if (startAt < BigInt(0) || startAt >= info.total) throw new Error('resume offset is outside the search space');
  const jobId = resume ? resume.jobId : await createJobRow(info, thresholdUsdt, startAt);
  if (resume) await patchJobRow(jobId, { status: 'running', last_error: null });

  engine.running = true;
  engine.stopRequested = false;
  engine.jobId = jobId;
  engine.info = info;
  engine.nextIndex = startAt;
  engine.checkedCount = startAt;
  engine.totalBig = info.total;
  // BSC USDT has 18 decimals: raw threshold = usdt * 10^18 (strictly greater test uses >= per owner spec ">0.1 saves" with threshold param)
  engine.thresholdRaw = BigInt(Math.round(thresholdUsdt * 1e6)) * BigInt(1000000000000);
  engine.thresholdUsdt = thresholdUsdt;
  engine.unknownCount = info.unknownPositions.length;
  engine.suffixFastPath = info.suffixContiguous;
  engine.found = 0;
  engine.startedAt = new Date().toISOString();
  engine.lastError = null;
  engine.recentChecks = [];
  engine.lastPersistAt = 0;

  void runLoop().catch(async (e) => {
    engine.lastError = e instanceof Error ? e.message : 'engine crashed';
    engine.running = false;
    if (engine.jobId) await patchJobRow(engine.jobId, { status: 'error', last_error: engine.lastError }).catch(() => {});
  });
  return engineSnapshot();
}

export async function resumeJob(jobId: string): Promise<EngineSnapshot> {
  if (engine.running) throw new Error('a scan is already running — stop it first');
  const res = await supa(`recovery_jobs?select=encrypted_template,threshold_usdt,checked_count,status&id=eq.${encodeURIComponent(jobId)}`, { method: 'GET' });
  if (!res.ok) throw new Error(`Supabase read failed: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ encrypted_template: string; threshold_usdt: string; checked_count: string; status: string }>;
  if (!rows[0]) throw new Error('job not found');
  const template = decryptPrivateKey(rows[0].encrypted_template);
  return startScan(template, Number(rows[0].threshold_usdt), { jobId, startAt: BigInt(rows[0].checked_count) });
}

export function stopScan(): EngineSnapshot {
  if (engine.running) engine.stopRequested = true;
  return engineSnapshot();
}

async function persistProgress(finalStatus?: string): Promise<void> {
  if (!engine.jobId) return;
  const now = Date.now();
  if (!finalStatus && now - engine.lastPersistAt < 5000) return;
  engine.lastPersistAt = now;
  await patchJobRow(engine.jobId, {
    checked_count: engine.checkedCount.toString(),
    found_count: engine.found,
    rate_per_sec: engine.ratePerSec,
    ...(finalStatus ? { status: finalStatus } : {}),
    ...(engine.lastError ? { last_error: engine.lastError } : {}),
  }).catch(() => {});
}

async function runLoop(): Promise<void> {
  const info = engine.info!;
  while (!engine.stopRequested && engine.nextIndex < engine.totalBig) {
    const roundSize = Math.min(CHUNK * CONCURRENCY, Number(engine.totalBig - engine.nextIndex > BigInt(CHUNK * CONCURRENCY) ? BigInt(CHUNK * CONCURRENCY) : engine.totalBig - engine.nextIndex));
    // Derive a full round, split into chunks, check chunks in parallel.
    const candidates = deriveBatch(info, engine.nextIndex, roundSize);
    const chunks: Candidate[][] = [];
    for (let i = 0; i < candidates.length; i += CHUNK) chunks.push(candidates.slice(i, i + CHUNK));

    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const valid = chunk.filter((c) => c.address !== '');
        const balances = valid.length ? await checkChunk(valid.map((c) => c.address)) : [];
        return { chunk, valid, balances };
      })
    );

    // If any chunk failed on all endpoints, pause and retry the whole round
    // (checkedCount only advances on fully verified rounds — no gaps).
    if (results.some((r) => r.balances === null)) {
      engine.lastError = engine.lastError || 'RPC pool unreachable — retrying';
      await persistProgress();
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const { valid, balances } of results) {
      for (let i = 0; i < valid.length; i++) {
        if (balances![i] >= engine.thresholdRaw) {
          try {
            await saveHit(engine.jobId!, valid[i].address, valid[i].keyHex, balances![i]);
            engine.found++;
          } catch (e) {
            engine.lastError = e instanceof Error ? e.message : 'hit save failed';
          }
        }
      }
    }

    engine.nextIndex += BigInt(roundSize);
    engine.checkedCount += BigInt(roundSize);
    const now = Date.now();
    for (let i = 0; i < roundSize; i++) engine.recentChecks.push(now);
    engineSnapshot(); // refresh rolling rate
    await persistProgress();
  }

  const done = engine.nextIndex >= engine.totalBig;
  engine.running = false;
  await persistProgress(done ? 'done' : 'stopped');
}
