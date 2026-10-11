// Shared claim-trigger logic. Runs in the long-lived Node process on Render,
// so the module-level lastRunDate persists across /wake ticks (resets on restart,
// which is harmless: run-auto-claims dedups via auto_claim_runs server-side).

export const WINDOW_MINUTES = 15;

let lastRunDate: string | null = null; // YYYY-MM-DD already triggered

export function getClaimTime(): string {
  return process.env.CLAIM_TIME_UTC || '18:00'; // HH:MM in UTC
}

export function getFunctionUrl(): string {
  return process.env.RUN_AUTO_CLAIMS_URL || '';
}

export function getLastRunDate(): string | null {
  return lastRunDate;
}

function minutesOfDay(h: number, m: number): number {
  return h * 60 + m;
}

export function isDue(now: Date = new Date()): boolean {
  const [h, m] = getClaimTime().split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return false;
  const scheduled = minutesOfDay(h, m);
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = now.toISOString().slice(0, 10);
  return nowMinutes >= scheduled && nowMinutes < scheduled + WINDOW_MINUTES && lastRunDate !== today;
}

export function nextRunUtc(now: Date = new Date()): Date {
  const [h, m] = getClaimTime().split(':').map(Number);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export async function triggerClaims(): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = getFunctionUrl();
  if (!url) return { ok: false, error: 'RUN_AUTO_CLAIMS_URL is not set' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'fetch failed' };
  }
}

export function markRan(now: Date = new Date()): void {
  lastRunDate = now.toISOString().slice(0, 10);
}

export function clearLastRun(): void {
  lastRunDate = null;
}
