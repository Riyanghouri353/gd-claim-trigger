// Shared scheduling logic. Supports MULTIPLE daily run times, e.g.
// "14:00,18:00,22:00". Each run is tracked as a slot "YYYY-MM-DDTHH:MM"
// so every slot runs at most once per day when it succeeds.
//
// Retry semantics (fixed Nov 2026 — the old code marked a slot complete
// even when chains failed, despite the comments claiming "success only"):
// - A slot is COMPLETE when a run finishes it with zero failed chains,
//   or after MAX_SLOT_ATTEMPTS attempts (exhausted — the next day's slots
//   still cover the entitlement, claims are idempotent).
// - A slot with failures stays DUE, but retries are gated: at most one
//   retry per SLOT_RETRY_GAP_MS, so a persistently failing chain (e.g.
//   Fuse gas) can't trigger a full re-run on every 10-minute wake tick.
// - Slot state persists in Supabase (claim_slots) and survives restarts
//   and deploys. An in-memory cache mirrors it; if Supabase is
//   unreachable the cache keeps the scheduler working with the same rules.

import { supaDelete, supaGet, supaPost } from './supa';

export const MAX_SLOT_ATTEMPTS = 3;
export const SLOT_RETRY_GAP_MS = 30 * 60_000;

export interface SlotState {
  key: string;
  attempts: number;
  lastAttemptAt: string | null;
  completedAt: string | null;
  lastClaimed: number;
  lastSkipped: number;
  lastFailed: number;
  lastBlocked: number;
}

export interface SlotSummary {
  claimed: number;
  skipped: number;
  failed: number;
  blocked: number;
}

/** Validated, deduped, sorted daily run times ("HH:MM", UTC). */
export function getClaimTimes(): string[] {
  const raw = process.env.CLAIM_TIMES_UTC || process.env.CLAIM_TIME_UTC || '18:00';
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const [hs, ms] = part.trim().split(':');
    const h = Number(hs);
    const m = Number(ms);
    if (Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  const times = Array.from(new Set(out)).sort();
  return times.length > 0 ? times : ['18:00']; // garbage env can never break the scheduler
}

function slotKey(today: string, time: string): string {
  return `${today}T${time}`;
}

function slotTimeUtc(key: string): Date {
  // key is "YYYY-MM-DDTHH:MM" in UTC
  return new Date(`${key}:00.000Z`);
}

/**
 * Pure retry rule: is this slot due right now?
 * - Not yet at its scheduled time -> not due.
 * - Completed -> not due.
 * - Never attempted -> due.
 * - Attempted, failed, under the attempt cap -> due only after the retry gap.
 */
export function isSlotDue(state: SlotState | null, key: string, now: Date = new Date()): boolean {
  if (now.getTime() < slotTimeUtc(key).getTime()) return false;
  if (!state) return true;
  if (state.completedAt) return false;
  if (state.attempts <= 0) return true;
  if (state.attempts >= MAX_SLOT_ATTEMPTS) return false;
  if (!state.lastAttemptAt) return true;
  return now.getTime() - new Date(state.lastAttemptAt).getTime() >= SLOT_RETRY_GAP_MS;
}

/* ---------------- persistent store (Supabase + memory cache) ---------------- */

const cache = new Map<string, SlotState>();
let lastRefreshAt = 0;
const REFRESH_THROTTLE_MS = 30_000;

interface SlotRow {
  slot_key: string;
  attempts: number;
  last_attempt_at: string | null;
  completed_at: string | null;
  last_claimed: number;
  last_skipped: number;
  last_failed: number;
  last_blocked: number;
}

function rowToState(r: SlotRow): SlotState {
  return {
    key: r.slot_key,
    attempts: r.attempts,
    lastAttemptAt: r.last_attempt_at,
    completedAt: r.completed_at,
    lastClaimed: r.last_claimed,
    lastSkipped: r.last_skipped,
    lastFailed: r.last_failed,
    lastBlocked: r.last_blocked,
  };
}

async function refreshCache(): Promise<void> {
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_THROTTLE_MS) return;
  lastRefreshAt = now;
  try {
    const rows = await supaGet<SlotRow[]>(
      'claim_slots?select=slot_key,attempts,last_attempt_at,completed_at,last_claimed,last_skipped,last_failed,last_blocked&order=slot_key',
    );
    for (const r of rows) cache.set(r.slot_key, rowToState(r));
  } catch (e) {
    // Supabase unreachable: keep serving from the memory cache.
    console.error('slots: refresh failed, using cached state:', e instanceof Error ? e.message : e);
  }
}

function pruneCache(now: Date): void {
  const cutoff = new Date(now.getTime() - 3 * 24 * 3600_000).toISOString().slice(0, 10);
  for (const k of Array.from(cache.keys())) {
    if (k.slice(0, 10) < cutoff) cache.delete(k);
  }
}

/** Slot keys due right now: at/after their scheduled time today and retry-eligible. */
export async function dueSlots(now: Date = new Date()): Promise<string[]> {
  await refreshCache();
  pruneCache(now);
  const today = now.toISOString().slice(0, 10);
  const due: string[] = [];
  for (const t of getClaimTimes()) {
    const key = slotKey(today, t);
    if (isSlotDue(cache.get(key) ?? null, key, now)) due.push(key);
  }
  return due;
}

export async function isDue(now: Date = new Date()): Promise<boolean> {
  return (await dueSlots(now)).length > 0;
}

/** The next scheduled run time (today's later slot, or tomorrow's first). */
export function nextRunUtc(now: Date = new Date()): Date {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const d = now.getUTCDate();
  const candidates: Date[] = [];
  for (const t of getClaimTimes()) {
    const [h, m] = t.split(':').map(Number);
    candidates.push(new Date(Date.UTC(y, mo, d, h, m)));
    candidates.push(new Date(Date.UTC(y, mo, d + 1, h, m)));
  }
  const future = candidates
    .filter((c) => c.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  return future[0];
}

/**
 * Record a run's outcome for its slots. Completes a slot only when the run
 * had zero failures, or when the attempt cap is reached (exhausted).
 * Never throws: a persistence failure must not break the run itself.
 */
export async function recordSlotOutcome(
  keys: string[],
  summary: SlotSummary,
  now: Date = new Date(),
): Promise<void> {
  if (keys.length === 0) return;
  const nowIso = now.toISOString();
  const upserts: Record<string, unknown>[] = [];
  for (const key of keys) {
    const prev = cache.get(key);
    const attempts = (prev?.attempts ?? 0) + 1;
    const complete = summary.failed === 0 || attempts >= MAX_SLOT_ATTEMPTS;
    const state: SlotState = {
      key,
      attempts,
      lastAttemptAt: nowIso,
      completedAt: complete ? nowIso : prev?.completedAt ?? null,
      lastClaimed: summary.claimed,
      lastSkipped: summary.skipped,
      lastFailed: summary.failed,
      lastBlocked: summary.blocked,
    };
    cache.set(key, state);
    upserts.push({
      slot_key: key,
      attempts: state.attempts,
      last_attempt_at: nowIso,
      completed_at: state.completedAt,
      last_claimed: summary.claimed,
      last_skipped: summary.skipped,
      last_failed: summary.failed,
      last_blocked: summary.blocked,
      updated_at: nowIso,
    });
  }
  try {
    await supaPost('claim_slots', upserts, { upsert: true });
  } catch (e) {
    console.error('slots: persist failed, memory cache kept:', e instanceof Error ? e.message : e);
  }
  // Best-effort prune of rows older than 3 days.
  try {
    const cutoff = new Date(now.getTime() - 3 * 24 * 3600_000).toISOString().slice(0, 10);
    await supaDelete('claim_slots', `slot_key=lt.${cutoff}`);
  } catch {
    /* pruning is cosmetic */
  }
}

export function getCompletedSlots(): string[] {
  return Array.from(cache.values())
    .filter((s) => s.completedAt)
    .map((s) => s.key)
    .sort();
}

export function getSlotStates(): SlotState[] {
  return Array.from(cache.values()).sort((a, b) => a.key.localeCompare(b.key));
}
