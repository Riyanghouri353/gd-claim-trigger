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

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

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

/* ---------- shared layout ---------- */

function shell(opts: { eyebrow: string; title: string; meta: string; body: string }): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#eef1f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 10px 34px rgba(15,23,42,0.10);">
<tr><td style="background:#ef4444;height:5px;font-size:0;line-height:5px;">&nbsp;</td></tr>
<tr><td style="background:#0b1220;padding:30px 34px;">
<div style="font-family:${FONT};font-size:11px;letter-spacing:2.5px;color:#f87171;font-weight:700;">${opts.eyebrow}</div>
<div style="font-family:${FONT};font-size:27px;font-weight:800;color:#ffffff;margin:10px 0 0;line-height:1.25;">${opts.title}</div>
<div style="font-family:${FONT};font-size:13px;color:#94a3b8;margin:10px 0 0;line-height:1.5;">${opts.meta}</div>
</td></tr>
<tr><td style="padding:26px 34px 6px;">${opts.body}</td></tr>
<tr><td align="center" style="padding:20px 34px 6px;">
<a href="${DASHBOARD_URL}" style="display:inline-block;background:#0b1220;color:#ffffff;font-family:${FONT};font-size:15px;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:999px;">Open dashboard&nbsp;&nbsp;&#8594;</a>
</td></tr>
<tr><td align="center" style="padding:22px 34px 30px;font-family:${FONT};font-size:12px;color:#94a3b8;">
G$ Claim Runner &middot; automated alerts &middot; gd-claim.ghouri.site
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function statCard(n: number, label: string, color: string): string {
  return `<td width="33%" align="center" style="background:#f8fafc;border-radius:14px;padding:18px 8px;">
<div style="font-family:${FONT};font-size:30px;font-weight:800;color:${color};line-height:1;">${n}</div>
<div style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;color:#64748b;margin-top:9px;">${label}</div>
</td>`;
}

function statsRow(claimed: number, skipped: number, failed: number): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
${statCard(claimed, 'CLAIMED', '#16a34a')}<td width="10" style="font-size:0;">&nbsp;</td>
${statCard(skipped, 'SKIPPED', '#64748b')}<td width="10" style="font-size:0;">&nbsp;</td>
${statCard(failed, 'FAILED', '#dc2626')}
</tr></table>`;
}

function sectionLabel(text: string): string {
  return `<div style="font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:2px;color:#0f172a;margin:24px 0 12px;">${text}</div>`;
}

function failureTable(failures: { wallet: string; chain: string; message: string }[]): string {
  const rows = failures
    .map(
      (f, i) => `<tr>
<td style="padding:14px 16px;font-family:${FONT};font-size:14px;font-weight:700;color:#0f172a;${i % 2 ? 'background:#f8fafc;' : ''}">${esc(f.wallet)}</td>
<td style="padding:14px 16px;${i % 2 ? 'background:#f8fafc;' : ''}"><span style="display:inline-block;font-family:${FONT};font-size:11px;font-weight:800;letter-spacing:1px;color:#0f172a;background:#e2e8f0;border-radius:999px;padding:6px 13px;">${esc(f.chain.toUpperCase())}</span></td>
<td style="padding:14px 16px;font-family:${MONO};font-size:12.5px;line-height:1.55;color:#475569;${i % 2 ? 'background:#f8fafc;' : ''}">${esc(f.message).slice(0, 300)}</td>
</tr>`,
    )
    .join('');
  return `${sectionLabel('WHAT FAILED')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
<tr>
<td style="background:#0b1220;color:#ffffff;font-family:${FONT};font-size:11px;font-weight:800;letter-spacing:1.5px;padding:13px 16px;">WALLET</td>
<td style="background:#0b1220;color:#ffffff;font-family:${FONT};font-size:11px;font-weight:800;letter-spacing:1.5px;padding:13px 16px;">CHAIN</td>
<td style="background:#0b1220;color:#ffffff;font-family:${FONT};font-size:11px;font-weight:800;letter-spacing:1.5px;padding:13px 16px;">ISSUE</td>
</tr>${rows}</table>`;
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

function feePill(fee: FeeCheckResult | null): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
<tr><td style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:14px 18px;font-family:${FONT};font-size:13.5px;font-weight:600;color:#047857;line-height:1.5;">
&#128737;&nbsp;&nbsp;${esc(feeLine(fee))}</td></tr></table>`;
}

/* ---------- builders (exported for preview/testing) ---------- */

export interface RunAlertInput {
  slotLabel: string;
  startedAt: string;
  finishedAt: string;
  results: WalletResult[];
  summary: { claimed: number; skipped: number; failed: number };
  fee: FeeCheckResult | null;
}

export function buildCrashEmail(
  slotLabel: string,
  startedAt: string,
  error: string,
): { subject: string; html: string; text: string } {
  const when = startedAt.replace('T', ' ').slice(0, 19) + ' UTC';
  const subject = `[G$ Runner] Claim run CRASHED — ${slotLabel}`;
  const text =
    `G$ Claim Runner — run crashed\n\n` +
    `Slot: ${slotLabel}\nStarted: ${when}\nError: ${error}\n\n` +
    `The slot was NOT marked complete, so the next wake tick will retry it.\n` +
    `Dashboard: ${DASHBOARD_URL}`;
  const body =
    `<div style="background:#0b1220;border-radius:14px;padding:18px 20px;font-family:${MONO};font-size:13px;line-height:1.6;color:#fca5a5;white-space:pre-wrap;word-break:break-word;">${esc(error).slice(0, 1000)}</div>` +
    `<p style="font-family:${FONT};font-size:14px;color:#475569;line-height:1.65;margin:18px 0 0;">The slot was <b>not</b> marked complete, so the next wake tick will retry it automatically.</p>`;
  const html = shell({
    eyebrow: 'G$ CLAIM RUNNER &middot; CRITICAL',
    title: 'Claim run crashed',
    meta: `${esc(slotLabel)} &middot; Started ${esc(when)}`,
    body,
  });
  return { subject, html, text };
}

export function buildFailureEmail(input: RunAlertInput): { subject: string; html: string; text: string } {
  const failures: { wallet: string; chain: string; message: string }[] = [];
  for (const w of input.results) {
    for (const c of w.chains) {
      if (c.status === 'failed') {
        failures.push({ wallet: w.label, chain: c.chain, message: c.message ?? 'failed' });
      }
    }
  }
  const when = input.startedAt.replace('T', ' ').slice(0, 19) + ' UTC';
  const dur = Math.max(
    1,
    Math.round((new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime()) / 1000),
  );
  const n = failures.length;
  const subject = `[G$ Runner] ${n} claim${n === 1 ? '' : 's'} failed — ${input.slotLabel}`;
  const text =
    `G$ Claim Runner — run completed with failures\n\n` +
    `Slot: ${input.slotLabel}\nStarted: ${when} (${dur}s)\n` +
    `Result: ${input.summary.claimed} claimed, ${input.summary.skipped} skipped, ${input.summary.failed} failed\n` +
    `${feeLine(input.fee)}\n\nFailures:\n` +
    failures.map((f) => `- ${f.wallet} [${f.chain}]: ${f.message}`.slice(0, 300)).join('\n') +
    `\n\nDashboard: ${DASHBOARD_URL}`;
  const body =
    statsRow(input.summary.claimed, input.summary.skipped, input.summary.failed) +
    failureTable(failures) +
    feePill(input.fee);
  const html = shell({
    eyebrow: 'G$ CLAIM RUNNER &middot; ACTION NEEDED',
    title: `${n} claim${n === 1 ? '' : 's'} failed`,
    meta: `${esc(input.slotLabel)} &middot; Started ${esc(when)} &middot; finished in ${dur}s`,
    body,
  });
  return { subject, html, text };
}

/** A run crashed before completing (Supabase down, decrypt blowup, unexpected error). Always alerts. */
export async function alertRunCrashed(slotLabel: string, startedAt: string, error: string): Promise<void> {
  const { subject, html, text } = buildCrashEmail(slotLabel, startedAt, error);
  await sendEmail(subject, html, text);
}

/** A run completed but with claim failures. Alerts unless the identical failure set already alerted within the cooldown. */
export async function maybeAlertRunFailures(input: RunAlertInput): Promise<void> {
  let failed = 0;
  for (const w of input.results) for (const c of w.chains) if (c.status === 'failed') failed++;
  if (failed === 0) return;

  const sig = input.results
    .flatMap((w) => w.chains.filter((c) => c.status === 'failed').map((c) => `${w.label}:${c.chain}`))
    .sort()
    .join('|');
  const now = Date.now();
  if (sig === lastFailureSig && now - lastFailureAlertAt < FAILURE_COOLDOWN_MS) {
    console.log('alerts: skipping duplicate failure alert (cooldown)');
    return;
  }
  lastFailureSig = sig;
  lastFailureAlertAt = now;

  const { subject, html, text } = buildFailureEmail(input);
  await sendEmail(subject, html, text);
}
