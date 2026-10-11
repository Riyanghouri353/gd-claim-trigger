'use client';

import { useCallback, useEffect, useState } from 'react';

/* ---------- types ---------- */

interface ChainResult {
  chain: string;
  status: 'claimed' | 'skipped' | 'failed';
  amount?: string;
  txHash?: string;
  explorerUrl?: string;
  message?: string;
  fundedGas?: boolean;
}

interface RunResult {
  startedAt: string;
  finishedAt: string;
  wallets: { label: string; chains: ChainResult[] }[];
  summary: { claimed: number; skipped: number; failed: number };
}

interface Status {
  ok: boolean;
  time: string;
  claimTimeUtc: string;
  chains: string[];
  walletsConfigured: number;
  gdClaimConfigured: boolean;
  nextRunUtc: string;
  running: boolean;
  lastRun: RunResult | null;
}

/* ---------- helpers ---------- */

function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function fmtShort(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function Countdown({ target }: { target: string }) {
  const now = useNow(1000);
  const diff = Math.max(0, new Date(target).getTime() - now.getTime());
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="tabular countdown">
      {h > 0 && <>{h}<span className="unit">h</span> </>}
      {pad(m)}
      <span className="unit">m</span> {pad(s)}
      <span className="unit">s</span>
    </span>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copybtn"
      title="Copy tx hash"
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

/* ---------- small pieces ---------- */

function StatCard({ label, children, accent }: { label: string; children: React.ReactNode; accent?: string }) {
  return (
    <div className={`stat ${accent ?? ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{children}</div>
    </div>
  );
}

function StatusPill({ status }: { status: ChainResult['status'] }) {
  const map = {
    claimed: ['st-claimed', '✓ claimed'],
    skipped: ['st-skipped', '– skipped'],
    failed: ['st-failed', '✗ failed'],
  } as const;
  const [cls, text] = map[status];
  return (
    <span className={`pill ${cls}`}>
      <span className="pdot" />
      {text}
    </span>
  );
}

/* ---------- main dashboard ---------- */

export default function Dashboard() {
  const [s, setS] = useState<Status | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) setS(await res.json());
    } catch {
      /* keep last state */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function manualTrigger() {
    if (!window.confirm('Run claims now for all wallets, outside the schedule?')) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/trigger', { method: 'POST' });
      const data = await res.json();
      setMsg(data.ok ? 'Run started — results appear below as chains complete.' : `Could not start: ${data.error}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
      load();
    }
  }

  if (!s) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Connecting to runner…</p>
      </div>
    );
  }

  const last = s.lastRun;
  const durationSec = last
    ? Math.max(1, Math.round((new Date(last.finishedAt).getTime() - new Date(last.startedAt).getTime()) / 1000))
    : 0;

  return (
    <div className="dash">
      {/* hero */}
      <header className="hero">
        <div>
          <h1>
            <span className="grad">G$ Claim Runner</span>
          </h1>
          <p className="sub">Autonomous parallel claims · every wallet · every chain · at once</p>
        </div>
        <div className="clockbox">
          <div className="clock-label">UTC now</div>
          <div className="clock-time tabular">{now.toISOString().slice(11, 19)}</div>
          <div className="clock-date">{now.toISOString().slice(0, 10)}</div>
        </div>
      </header>

      {/* stats */}
      <section className="stats">
        <StatCard label="Status" accent={s.running ? 'accent' : ''}>
          {s.running ? (
            <span className="live">
              <span className="pulse" />
              Running
            </span>
          ) : (
            <span className="idle">Idle</span>
          )}
        </StatCard>
        <StatCard label="Next scheduled run">
          <Countdown target={s.nextRunUtc} />
          <div className="stat-sub">{fmtShort(s.nextRunUtc)} UTC</div>
        </StatCard>
        <StatCard label="Wallets">
          <span className="bignum tabular">{s.walletsConfigured}</span>
          <div className="stat-sub">configured</div>
        </StatCard>
        <StatCard label="Chains">
          <div className="chainrow">
            {s.chains.map((c) => (
              <span key={c} className={`chainbadge chain-${c}`}>
                {c}
              </span>
            ))}
          </div>
          <div className="stat-sub">daily at {s.claimTimeUtc} UTC</div>
        </StatCard>
      </section>

      {/* manual trigger */}
      <section className="card actions">
        <div>
          <div className="card-title">Manual control</div>
          <p className="muted small">Runs all wallets immediately, outside the schedule.</p>
        </div>
        <div className="actions-right">
          <button className="btn-primary" onClick={manualTrigger} disabled={busy || s.running}>
            {busy ? 'Starting…' : s.running ? 'Run in progress…' : '▶ Run claims now'}
          </button>
          {msg && <p className="muted small msg">{msg}</p>}
        </div>
      </section>

      {/* results */}
      <section className="card">
        <div className="card-title">Last run</div>
        {!last ? (
          <div className="empty">
            <div className="empty-icon">◷</div>
            <p>No runs yet.</p>
            <p className="muted small">
              The first scheduled run will appear here — or trigger one manually above.
            </p>
          </div>
        ) : (
          <>
            <div className="summary">
              <span className="pill st-claimed">
                <span className="pdot" />✓ {last.summary.claimed} claimed
              </span>
              <span className="pill st-skipped">
                <span className="pdot" />– {last.summary.skipped} skipped
              </span>
              <span className="pill st-failed">
                <span className="pdot" />✗ {last.summary.failed} failed
              </span>
              <span className="muted small">
                {fmt(last.startedAt)} → {fmt(last.finishedAt)} · {durationSec}s
              </span>
            </div>
            <div className="tablewrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Wallet</th>
                    <th>Chain</th>
                    <th>Status</th>
                    <th>Amount</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {last.wallets.flatMap((w) =>
                    w.chains.map((c, i) => (
                      <tr key={`${w.label}-${c.chain}`} className="fadein">
                        {i === 0 && (
                          <td rowSpan={w.chains.length} className="wallet">
                            {w.label}
                          </td>
                        )}
                        <td>
                          <span className={`chainbadge chain-${c.chain}`}>{c.chain}</span>
                        </td>
                        <td>
                          <StatusPill status={c.status} />
                          {c.fundedGas && (
                            <span className="pill st-gas">
                              <span className="pdot" />
                              ⛽ funded
                            </span>
                          )}
                        </td>
                        <td className="tabular">{c.amount ? `${c.amount} G$` : '—'}</td>
                        <td className="detail">
                          {c.explorerUrl ? (
                            <>
                              <a href={c.explorerUrl} target="_blank" rel="noreferrer" className="txlink">
                                {c.txHash?.slice(0, 12)}…
                              </a>{' '}
                              {c.txHash && <CopyBtn text={c.txHash} />}
                            </>
                          ) : (
                            <span className="muted">{c.message?.slice(0, 90)}</span>
                          )}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* config */}
      <details className="card config">
        <summary>Configuration</summary>
        <ul className="cfglist">
          <li>
            gd-claim endpoint <span className={s.gdClaimConfigured ? 'ok' : 'error'}>{s.gdClaimConfigured ? '✓' : '✗'}</span>
          </li>
          <li>
            Keep-alive <code>/api/wake</code> <span className="muted">— hit every 10 min (cron-job.org)</span>
          </li>
          <li>
            Health <a href="/api/wake"><code>/api/wake</code></a> <span className="muted">— live JSON</span>
          </li>
        </ul>
      </details>
    </div>
  );
}
