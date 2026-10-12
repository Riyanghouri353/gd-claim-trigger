// Shared scheduling logic. Runs in the long-lived Node process on Render,
// so the module-level lastRunDate persists across /wake ticks.
// (Resets on restart — harmless: the next tick at/after the claim time simply
// runs once, and further ticks the same day are deduped by lastRunDate.)

function parseClaimTime(): { h: number; m: number } {
  const raw = process.env.CLAIM_TIME_UTC || '18:00';
  const [hs, ms] = raw.split(':');
  const h = Number(hs);
  const m = Number(ms);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return { h: 18, m: 0 }; // garbage env can never crash the scheduler
  }
  return { h, m };
}

export function getClaimTime(): string {
  const { h, m } = parseClaimTime();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

let lastRunDate: string | null = null; // YYYY-MM-DD of the last COMPLETED run

export function getLastRunDate(): string | null {
  return lastRunDate;
}

function minutesOfDay(h: number, m: number): number {
  return h * 60 + m;
}

export function isDue(now: Date = new Date()): boolean {
  const { h, m } = parseClaimTime();
  const scheduled = minutesOfDay(h, m);
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = now.toISOString().slice(0, 10);
  // Any tick at/after the claim time triggers exactly one run per day.
  // No narrow window: a late or cold-start tick can never silently skip the day.
  return nowMinutes >= scheduled && lastRunDate !== today;
}

export function nextRunUtc(now: Date = new Date()): Date {
  const { h, m } = parseClaimTime();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/**
 * Record a calendar date (YYYY-MM-DD) as completed.
 * Called ONLY on successful runs — a failed run stays eligible so a later
 * tick the same day retries it instead of silently skipping.
 */
export function markRanDate(dateStr: string): void {
  lastRunDate = dateStr;
}
