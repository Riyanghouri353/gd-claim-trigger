// Email alerts for run crashes and claim failures, sent via Resend.
// From: riyan@ghouri.site (verified domain) → To: riyanghouri7@gmail.com (override via ALERT_EMAIL).
// Alerts must never break a run: every send is wrapped in try/catch by callers.

import type { FeeCheckResult } from './fees';
import type { WalletResult } from './runner';

const RESEND_API = 'https://api.resend.com/emails';
const DASHBOARD_URL = 'https://gd-claim.ghouri.site/#/logs';

// Cooldown so a recurring failure (e.g. the same wallet short on gas every run)
// doesn't email 3x a day: identical failure sets re-alert at most every 12h.
// Crashes always alert immediately.
const FAILURE_COOLDOWN_MS = 12 * 3600_000;
let lastFailureSig = '';
let lastFailureAlertAt = 0;

export function alertsConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

function getAlertTo(): string {
  return process.env.ALERT_EMAIL || 'riyanghouri7@gmail.com';
}

function getAlertFrom(): string {
  return process.env.ALERT_FROM || 'riyan@ghouri.site';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendEmail(subject: string, html: string, text: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('alerts: RESEND_API_KEY not set — skipping email alert');
    return;
  }
  const res = await fetch(RESEND_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `G$ Claim Runner <${getAlertFrom()}>`,
      to: [getAlertTo()],
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API ${res.status}: ${body.slice(0, 200)}`);
  }
  console.log('alerts: email sent —', subject);
}

function failureRows(failures: { wallet: string; chain: string; message: string }[]): string {
  return failures
    .map(
      (f) =>
        `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee">${esc(f.wallet)}</td>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #eee">${esc(f.chain)}</td>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #eee">${esc(f.message).slice(0, 300)}</td></tr>`,
    )
    .join('');
}

function feeLine(fee: FeeCheckResult | null): string {
  if (!fee) return 'Fee Guard: no data (check failed before claims)';
  const topped = fee.wallets.filter((w) => w.toppedUp).length;
  const failed = fee.wallets.filter((w) => !w.toppedUp && w.balanceBefore == null).length;
  const parts = [`${fee.wallets.length} wallets checked`];
  if (topped > 0) parts.push(`${topped} topped up`);
  if (failed > 0) parts.push(`${failed} check failed`);
  return `Fee Guard: ${parts.join(' · ')} (threshold ${fee.threshold} CELO)`;
}

/** A run crashed before completing (Supabase down, decrypt blowup, unexpected error). Always alerts. */
export async function alertRunCrashed(slotLabel: string, startedAt: string, error: string): Promise<void> {
  const when = startedAt.replace('T', ' ').slice(0, 19) + ' UTC';
  const subject = `[G$ Runner] Claim run CRASHED — ${slotLabel}`;
  const text =
    `G$ Claim Runner — run crashed\n\n` +
    `Slot: ${slotLabel}\nStarted: ${when}\nError: ${error}\n\n` +
    `The slot was NOT marked complete, so the next wake tick will retry it.\n` +
    `Dashboard: ${DASHBOARD_URL}`;
  const html =
    `<h2 style="color:#dc2626">G$ Claim Runner — run crashed</h2>` +
    `<p><b>Slot:</b> ${esc(slotLabel)}<br><b>Started:</b> ${esc(when)}</p>` +
    `<p><b>Error:</b></p><pre style="background:#fef2f2;padding:12px;border-radius:8px;white-space:pre-wrap">${esc(error).slice(0, 1000)}</pre>` +
    `<p>The slot was <b>not</b> marked complete, so the next wake tick will retry it.</p>` +
    `<p><a href="${DASHBOARD_URL}">Open the dashboard</a></p>`;
  await sendEmail(subject, html, text);
}

export interface RunAlertInput {
  slotLabel: string;
  startedAt: string;
  finishedAt: string;
  results: WalletResult[];
  summary: { claimed: number; skipped: number; failed: number };
  fee: FeeCheckResult | null;
}

/** A run completed but with claim failures. Alerts unless the identical failure set already alerted within the cooldown. */
export async function maybeAlertRunFailures(input: RunAlertInput): Promise<void> {
  const failures: { wallet: string; chain: string; message: string }[] = [];
  for (const w of input.results) {
    for (const c of w.chains) {
      if (c.status === 'failed') {
        failures.push({ wallet: w.label, chain: c.chain, message: c.message ?? 'failed' });
      }
    }
  }
  if (failures.length === 0) return;

  const sig = failures
    .map((f) => `${f.wallet}:${f.chain}`)
    .sort()
    .join('|');
  const now = Date.now();
  if (sig === lastFailureSig && now - lastFailureAlertAt < FAILURE_COOLDOWN_MS) {
    console.log('alerts: skipping duplicate failure alert (cooldown)');
    return;
  }
  lastFailureSig = sig;
  lastFailureAlertAt = now;

  const when = input.startedAt.replace('T', ' ').slice(0, 19) + ' UTC';
  const dur = Math.max(
    1,
    Math.round((new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime()) / 1000),
  );
  const subject = `[G$ Runner] ${failures.length} claim${failures.length === 1 ? '' : 's'} failed — ${input.slotLabel}`;
  const text =
    `G$ Claim Runner — run completed with failures\n\n` +
    `Slot: ${input.slotLabel}\nStarted: ${when} (${dur}s)\n` +
    `Result: ${input.summary.claimed} claimed, ${input.summary.skipped} skipped, ${input.summary.failed} failed\n` +
    `${feeLine(input.fee)}\n\nFailures:\n` +
    failures.map((f) => `- ${f.wallet} [${f.chain}]: ${f.message}`.slice(0, 300)).join('\n') +
    `\n\nDashboard: ${DASHBOARD_URL}`;
  const html =
    `<h2 style="color:#dc2626">G$ Claim Runner — ${failures.length} claim${failures.length === 1 ? '' : 's'} failed</h2>` +
    `<p><b>Slot:</b> ${esc(input.slotLabel)}<br><b>Started:</b> ${esc(when)} (${dur}s)<br>` +
    `<b>Result:</b> ${input.summary.claimed} claimed, ${input.summary.skipped} skipped, ${input.summary.failed} failed<br>` +
    `<b>${esc(feeLine(input.fee))}</b></p>` +
    `<table style="border-collapse:collapse;font-size:14px"><thead><tr>` +
    `<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #ddd">Wallet</th>` +
    `<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #ddd">Chain</th>` +
    `<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #ddd">Issue</th>` +
    `</tr></thead><tbody>${failureRows(failures)}</tbody></table>` +
    `<p><a href="${DASHBOARD_URL}">Open the dashboard</a></p>`;
  await sendEmail(subject, html, text);
}
