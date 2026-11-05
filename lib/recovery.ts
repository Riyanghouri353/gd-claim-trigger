// Wallet key recovery engine — Riyan lost the last digit(s) of one of his own
// EVM private keys. He supplies the known part as a 64-char template with '?'
// for each unknown hex digit; the engine enumerates every combination
// (16^n), derives each address, and checks its USDT (BEP20, BSC) balance.
// Any candidate with balance >= threshold is a HIT: its full private key is
// stored AES-256-GCM ENCRYPTED (lib/crypto.ts, PROJECT_KEY) in the Supabase
// `recovery_hits` table. Plaintext keys exist only in server memory during
// the scan and in the explicit reveal call the owner makes from the UI.
//
// SPEED DESIGN (v2, after live measurement 2026-11-05):
// - Derivation is incremental when the unknown digits are the suffix (the
//   lost-last-digits case): one full scalar multiplication per chunk, then
//   each next candidate is a single EC point addition of G (~10k/sec
//   measured). Non-suffix templates use a full multiplication per candidate
//   (~2.5k/sec). Either way derivation outruns the network.
// - Balance checks use JSON-RPC BATCH eth_call requests against a pool of
//   public BSC endpoints. A worker pipeline (10 workers) keeps every
//   endpoint busy in parallel: no worker waits on a slow endpoint, failed
//   chunks are re-queued (and split after repeated failure), and each
//   endpoint has its own max batch size + cooldown. Single-endpoint
//   batch rates measured 200–2,700/sec; the pool sustains the aggregate.
// - The loop runs in the long-lived Render Node process (globalThis
//   singleton), NOT in a request handler, so it runs continuously until the
//   owner stops it, the space is exhausted, or the process restarts (jobs
//   persist in Supabase and can be resumed from the UI; resume restarts from
//   the contiguous verified watermark, so no candidate is ever skipped).
//
// This module is fully separate from the G$ claim runner and the agent:
// it touches no claim/agent tables, files, or schedules.

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { encryptPrivateKey, decryptPrivateKey } from './crypto';

const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'; // 18 decimals on BSC
const BALANCE_OF = '0x70a08231';
const WORKERS = 10;
const MAX_UNKNOWN = 8; // 16^8 = 4.29B — hard cap, UI warns long before this
const RPC_TIMEOUT_MS = 8000;

interface RpcEndpoint {
  url: string;
  maxBatch: number;
  cooldownUntil: number;
  failures: number;
  inFlight: number;
}

// Endpoints verified 2026-11-05 to accept JSON-RPC batch eth_call.
// (1rpc and blastapi were dropped: they reject batch requests outright.)
const endpoints: RpcEndpoint[] = [
  { url: 'https://bsc-dataseed.binance.org', maxBatch: 100, cooldownUntil: 0, failures: 0, inFlight: 0 },
  { url: 'https://bsc-dataseed1.defibit.io', maxBatch: 100, cooldownUntil: 0, failures: 0, inFlight: 0 },
  { url: 'https://bsc-dataseed1.ninicoin.io', maxBatch: 100, cooldownUntil: 0, failures: 0, inFlight: 0 },
  { url: 'https://bsc.drpc.org', maxBatch: 250, cooldownUntil: 0, failures: 0, inFlight: 0 },
  { url: 'https://binance.llamarpc.com', maxBatch: 250, cooldownUntil: 0, failures: 0, inFlight: 0 },
  { url: 'https://bsc.publicnode.com', maxBatch: 250, cooldownUntil: 0, failures: 0, inFlight: 0 },
];

function pickEndpoint(): RpcEndpoint | null {
  const now = Date.now();
  let best: RpcEndpoint | null = null;
  for (const ep of endpoints) {
    if (ep.cooldownUntil > now) continue;
    if (!best || ep.inFlight < best.inFlight) best = ep;
  }
  return best;
}

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
    const baseKey = candidateKey(info, start);
    const basePriv = BigInt('0x' + baseKey);
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
// BSC USDT balance check on one endpoint (JSON-RPC batch eth_call)
// ---------------------------------------------------------------------------

/** Returns raw balances (18-dec units) aligned with `addresses`, or throws. */
async function checkChunkOn(ep: RpcEndpoint, addresses: string[]): Promise<bigint[]> {
  const body = addresses.map((a, i) => ({
    jsonrpc: '2.0',
    id: i,
    method: 'eth_call',
    params: [{ to: USDT_BSC, data: BALANCE_OF + '000000000000000000000000' + a.slice(2) }, 'latest'],
  }));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
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
    return out;
  } finally {
    clearTimeout(timer);
  }
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
// Engine — worker pipeline, one scan at a time
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

interface Range {
  start: bigint;
  count: number;
  attempts: number;
}

interface EngineState {
  running: boolean;
  stopRequested: boolean;
  jobId: string | null;
  info: TemplateInfo | null;
  totalBig: bigint;
  thresholdRaw: bigint;
  nextAlloc: bigint; // next index never yet handed to a worker
  retryQueue: Range[];
  completedStarts: Set<string>; // chunk starts verified, for watermark
  watermark: bigint; // contiguous verified progress — safe resume point
  verifiedTotal: number; // all verified candidates this run (for rate)
  found: number;
  ratePerSec: number;
  startedAt: string | null;
  lastError: string | null;
  thresholdUsdt: number;
  unknownCount: number;
  suffixFastPath: boolean;
  recentChecks: number[];
  lastPersistAt: number;
  activeWorkers: number;
}

const g = globalThis as unknown as { __recoveryEngine?: EngineState };
const engine: EngineState =
  g.__recoveryEngine ||
  (g.__recoveryEngine = {
    running: false,
    stopRequested: false,
    jobId: null,
    info: null,
    totalBig: BigInt(0),
    thresholdRaw: BigInt(0),
    nextAlloc: BigInt(0),
    retryQueue: [],
    completedStarts: new Set<string>(),
    watermark: BigInt(0),
    verifiedTotal: 0,
    found: 0,
    ratePerSec: 0,
    startedAt: null,
    lastError: null,
    thresholdUsdt: 0.1,
    unknownCount: 0,
    suffixFastPath: false,
    recentChecks: [],
    lastPersistAt: 0,
    activeWorkers: 0,
  });

export function engineSnapshot(): EngineSnapshot {
  const cutoff = Date.now() - 10000;
  engine.recentChecks = engine.recentChecks.filter((t) => t >= cutoff);
  if (engine.running) engine.ratePerSec = Math.round(engine.recentChecks.length) / 10;
  return {
    running: engine.running,
    jobId: engine.jobId,
    total: engine.totalBig.toString(),
    checked: engine.watermark.toString(),
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
  engine.totalBig = info.total;
  // BSC USDT has 18 decimals: raw threshold = usdt * 10^18
  engine.thresholdRaw = BigInt(Math.round(thresholdUsdt * 1e6)) * BigInt(1000000000000);
  engine.thresholdUsdt = thresholdUsdt;
  engine.unknownCount = info.unknownPositions.length;
  engine.suffixFastPath = info.suffixContiguous;
  engine.nextAlloc = startAt;
  engine.watermark = startAt;
  engine.retryQueue = [];
  engine.completedStarts = new Set<string>();
  engine.verifiedTotal = 0;
  engine.found = 0;
  engine.startedAt = new Date().toISOString();
  engine.lastError = null;
  engine.recentChecks = [];
  engine.ratePerSec = 0;
  engine.lastPersistAt = 0;
  engine.activeWorkers = 0;
  for (const ep of endpoints) {
    ep.cooldownUntil = 0;
    ep.failures = 0;
    ep.inFlight = 0;
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < WORKERS; i++) workers.push(workerLoop());
  void Promise.all(workers)
    .then(async () => {
      engine.running = false;
      const done = engine.watermark >= engine.totalBig;
      await persistProgress(done ? 'done' : 'stopped');
    })
    .catch(async (e) => {
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
    checked_count: engine.watermark.toString(),
    found_count: engine.found,
    rate_per_sec: engine.ratePerSec,
    ...(finalStatus ? { status: finalStatus } : {}),
    ...(engine.lastError ? { last_error: engine.lastError } : {}),
  }).catch(() => {});
}

/** Hand out the next range to check: retries first, then fresh space sized
 *  to the endpoint the worker will use. Returns null when nothing remains. */
function allocateRange(maxBatch: number): Range | null {
  const retry = engine.retryQueue.shift();
  if (retry) return retry;
  if (engine.nextAlloc >= engine.totalBig) return null;
  const remaining = engine.totalBig - engine.nextAlloc;
  const count = remaining < BigInt(maxBatch) ? Number(remaining) : maxBatch;
  const range = { start: engine.nextAlloc, count, attempts: 0 };
  engine.nextAlloc += BigInt(count);
  return range;
}

// completedStarts stores "start:count" keys so the watermark can advance exactly.
function recordCompleted(range: Range): void {
  engine.completedStarts.add(`${range.start.toString()}:${range.count}`);
  for (;;) {
    let hitKey: string | null = null;
    let hitCount = 0;
    engine.completedStarts.forEach((key) => {
      if (hitKey) return;
      const parts = key.split(':');
      if (BigInt(parts[0]) === engine.watermark) {
        hitKey = key;
        hitCount = Number(parts[1]);
      }
    });
    if (!hitKey) break;
    engine.completedStarts.delete(hitKey);
    engine.watermark += BigInt(hitCount);
  }
}

async function workerLoop(): Promise<void> {
  const info = engine.info!;
  engine.activeWorkers++;
  try {
    for (;;) {
      if (engine.stopRequested) return;
      // Done when everything allocated, nothing queued, watermark complete.
      if (engine.nextAlloc >= engine.totalBig && engine.retryQueue.length === 0 && engine.watermark >= engine.totalBig) return;
      const ep = pickEndpoint();
      if (!ep) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      const range = allocateRange(ep.maxBatch);
      if (!range) {
        // Space allocated but other workers still verifying — wait briefly.
        if (engine.watermark >= engine.totalBig) return;
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      let candidates: Candidate[];
      try {
        candidates = deriveBatch(info, range.start, range.count);
      } catch (e) {
        engine.lastError = e instanceof Error ? e.message : 'derivation failed';
        return;
      }
      const valid = candidates.filter((c) => c.address !== '');
      ep.inFlight++;
      try {
        const balances = valid.length ? await checkChunkOn(ep, valid.map((c) => c.address)) : [];
        ep.failures = 0;
        for (let i = 0; i < valid.length; i++) {
          if (balances[i] >= engine.thresholdRaw) {
            try {
              await saveHit(engine.jobId!, valid[i].address, valid[i].keyHex, balances[i]);
              engine.found++;
            } catch (e) {
              engine.lastError = e instanceof Error ? e.message : 'hit save failed';
            }
          }
        }
        const now = Date.now();
        for (let i = 0; i < range.count; i++) engine.recentChecks.push(now);
        engine.verifiedTotal += range.count;
        recordCompleted(range);
        engineSnapshot();
        await persistProgress();
      } catch (e) {
        ep.failures++;
        ep.cooldownUntil = Date.now() + Math.min(45000, 4000 * ep.failures);
        engine.lastError = `${ep.url}: ${e instanceof Error ? e.message : 'rpc error'}`;
        range.attempts++;
        if (range.count > 25 && range.attempts >= 2) {
          // Split stubborn ranges so one bad slice cannot stall the scan.
          const half = Math.floor(range.count / 2);
          engine.retryQueue.push({ start: range.start, count: half, attempts: 0 });
          engine.retryQueue.push({ start: range.start + BigInt(half), count: range.count - half, attempts: 0 });
        } else {
          engine.retryQueue.push(range);
        }
        await new Promise((r) => setTimeout(r, 250));
      } finally {
        ep.inFlight--;
      }
    }
  } finally {
    engine.activeWorkers--;
  }
}

