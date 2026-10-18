'use client';

import { useCallback, useEffect, useState } from 'react';

/* ------------------------------------------------------------------ */
/* Types — mirror the /api/* payloads exactly (backend untouched)       */
/* ------------------------------------------------------------------ */

export interface ChainResult {
  chain: string;
  status: 'claimed' | 'skipped' | 'failed';
  amount?: string;
  txHash?: string;
  explorerUrl?: string;
  message?: string;
  fundedGas?: boolean;
}

export interface RunResult {
  startedAt: string;
  finishedAt: string;
  wallets: { label: string; chains: ChainResult[] }[];
  summary: { claimed: number; skipped: number; failed: number };
}

export interface FeeWallet {
  label: string;
  balanceBefore: number | null;
  balanceAfter: number | null;
  toppedUp: boolean;
  message?: string;
}

export interface FeeCheck {
  checkedAt: string;
  threshold: number;
  wallets: FeeWallet[];
}

export interface VaultWallet {
  id: string;
  label: string;
  chains: string[];
  keyOk: boolean;
  address: string | null;
}

export interface Status {
  ok: boolean;
  time: string;
  claimTimesUtc: string[];
  chains: string[];
  dbConfigured: boolean;
  dbError: string | null;
  walletsConfigured: number;
  wallets: VaultWallet[];
  gdClaimConfigured: boolean;
  nextRunUtc: string;
  running: boolean;
  lastRun: RunResult | null;
  feeThreshold: number;
  feeCheck: FeeCheck | null;
}

/* ------------------------------------------------------------------ */
/* Hooks + formatting                                                  */
/* ------------------------------------------------------------------ */

export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useStatus(pollMs = 5000): { status: Status | null; reload: () => void } {
  const [status, setStatus] = useState<Status | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (res.ok) setStatus(await res.json());
    } catch {
      /* keep last state on network blips */
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);
  return { status, reload: load };
}

export function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function fmtShort(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

export function fmtAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-head">
          {title && <h2 className="card-title">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  children,
  accent = false,
}: {
  label: string;
  children: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={`stat${accent ? ' accent' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{children}</div>
    </div>
  );
}

type PillTone = 'ok' | 'warn' | 'error' | 'muted' | 'info';

export function Pill({
  tone = 'muted',
  title,
  children,
}: {
  tone?: PillTone;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`pill tone-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function ChainBadge({ chain }: { chain: string }) {
  return <span className={`chainbadge chain-${chain}`}>{chain}</span>;
}

export function StatusPill({ status }: { status: ChainResult['status'] }) {
  const map = { claimed: 'ok', skipped: 'warn', failed: 'error' } as const;
  const label = { claimed: 'Claimed', skipped: 'Skipped', failed: 'Failed' }[status];
  return <Pill tone={map[status]}>{label}</Pill>;
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: string;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <p className="empty-title">{title}</p>
      {hint && <p className="muted small">{hint}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-label={label}>
      <div className="spinner" />
      <p>{label}</p>
    </div>
  );
}

export function Countdown({ target }: { target: string }) {
  const now = useNow(1000);
  const diff = Math.max(0, new Date(target).getTime() - now.getTime());
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="tabular countdown" aria-label={`${h} hours ${m} minutes ${s} seconds`}>
      {h > 0 && (
        <>
          {h}
          <span className="unit">h</span>{' '}
        </>
      )}
      {pad(m)}
      <span className="unit">m</span> {pad(s)}
      <span className="unit">s</span>
    </span>
  );
}

export function CopyBtn({ text, label = 'Copy transaction hash' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copybtn"
      title={label}
      aria-label={label}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function SegmentedBar({
  claimed,
  skipped,
  failed,
}: {
  claimed: number;
  skipped: number;
  failed: number;
}) {
  const total = claimed + skipped + failed;
  if (total === 0) return null;
  const pct = (n: number) => `${Math.max(n / total, 0.02) * 100}%`;
  return (
    <div
      className="segbar"
      role="img"
      aria-label={`${claimed} claimed, ${skipped} skipped, ${failed} failed`}
    >
      {claimed > 0 && <span className="seg seg-claimed" style={{ width: pct(claimed) }} />}
      {skipped > 0 && <span className="seg seg-skipped" style={{ width: pct(skipped) }} />}
      {failed > 0 && <span className="seg seg-failed" style={{ width: pct(failed) }} />}
    </div>
  );
}
