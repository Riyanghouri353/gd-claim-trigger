// Shared scheduling logic. Supports MULTIPLE daily run times, e.g. "18:00,22:00"
// (two runs a day, four hours apart). Each run is tracked as a slot
// "YYYY-MM-DDT HH:MM" so every slot runs exactly once per day.
// Runs in the long-lived Node process on Render; completedSlots persists across
// /wake ticks (resets on restart — harmless: the next tick simply runs any due slot).

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

// Completed run slots: "YYYY-MM-DDT HH:MM" (UTC date + scheduled time).
const completedSlots = new Set<string>();

function slotKey(today: string, time: string): string {
  return `${today}T${time}`;
}

/** Slot keys due right now: at/after their scheduled time today and not yet completed. */
export function dueSlots(now: Date = new Date()): string[] {
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = now.toISOString().slice(0, 10);
  const due: string[] = [];
  for (const t of getClaimTimes()) {
    const [h, m] = t.split(':').map(Number);
    if (nowMinutes >= h * 60 + m) {
      const key = slotKey(today, t);
      if (!completedSlots.has(key)) due.push(key);
    }
  }
  return due;
}

export function isDue(now: Date = new Date()): boolean {
  return dueSlots(now).length > 0;
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
 * Mark slot keys complete. Called ONLY on successful runs — a failed run
 * leaves its slots eligible so a later tick retries them.
 */
export function markSlotsComplete(keys: string[]): void {
  for (const k of keys) completedSlots.add(k);
  // prune anything older than 3 days so the set can't grow unbounded
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 3);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  Array.from(completedSlots).forEach((k) => {
    if (k.slice(0, 10) < cutoffStr) completedSlots.delete(k);
  });
}

export function getCompletedSlots(): string[] {
  return Array.from(completedSlots).sort();
}
