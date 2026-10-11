'use client';

import { useCallback, useEffect, useState } from 'react';

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

function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export default function Dashboard() {
  const [s, setS] = useState<Status | null>(null);
  const [triggerMsg, setTriggerMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      setS(await res.json());
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
    setTriggerMsg('Starting…');
    try {
      const res = await fetch('/api/trigger', { method: 'POST' });
      const data = await res.json();
      setTriggerMsg(data.ok ? 'Run started — watch the table below.' : `Could not start: ${data.error}`);
    } catch (e) {
      setTriggerMsg(e instanceof Error ? e.message : 'request failed');
    }
    load();
  }

  if (!s) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="grid">
        <div className="card">
          <div className="label">Server time</div>
          <div className="value">{fmt(s.time)}</div>
        </div>
        <div className="card">
          <div className="label">Daily claim time (UTC)</div>
          <div className="value">{s.claimTimeUtc}</div>
        </div>
        <div className="card">
          <div className="label">Next scheduled run</div>
          <div className="value">{fmt(s.nextRunUtc)}</div>
        </div>
        <div className="card">
          <div className="label">Wallets configured</div>
          <div className="value">{s.walletsConfigured}</div>
        </div>
      </div>

      <div className="card">
        <div className="label">Status</div>
        <p>
          {s.running ? (
            <span className="pill running">● Running…</span>
          ) : (
            <span className="pill idle">● Idle</span>
          )}{' '}
          <span className="muted small">
            gd-claim endpoint: {s.gdClaimConfigured ? 'ok' : 'default'} · chains: {s.chains.join(', ')}
          </span>
        </p>
        <button className="btn" onClick={manualTrigger} disabled={s.running}>
          {s.running ? 'Run in progress…' : 'Run claims now'}
        </button>
        {triggerMsg && <p className="muted small">{triggerMsg}</p>}
      </div>

      <div className="card">
        <div className="label">Last run</div>
        {!s.lastRun ? (
          <p className="muted">No run yet.</p>
        ) : (
          <>
            <p>
              <span className="pill ok">✓ {s.lastRun.summary.claimed} claimed</span>{' '}
              <span className="pill warn">– {s.lastRun.summary.skipped} skipped</span>{' '}
              <span className="pill err">✗ {s.lastRun.summary.failed} failed</span>
            </p>
            <p className="muted small">
              {fmt(s.lastRun.startedAt)} → {fmt(s.lastRun.finishedAt)}
            </p>
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
                {s.lastRun.wallets.flatMap((w) =>
                  w.chains.map((c, i) => (
                    <tr key={`${w.label}-${c.chain}`}>
                      {i === 0 && (
                        <td rowSpan={w.chains.length} className="wallet">
                          {w.label}
                        </td>
                      )}
                      <td><span className="chain">{c.chain}</span></td>
                      <td>
                        <span className={`pill ${c.status}`}>
                          {c.status === 'claimed' ? '✓ claimed' : c.status === 'skipped' ? '– skipped' : '✗ failed'}
                        </span>
                        {c.fundedGas && <span className="pill gas">⛽ funded</span>}
                      </td>
                      <td>{c.amount ? `${c.amount} G$` : '—'}</td>
                      <td className="detail">
                        {c.explorerUrl ? (
                          <a href={c.explorerUrl} target="_blank" rel="noreferrer">
                            {c.txHash?.slice(0, 10)}…
                          </a>
                        ) : (
                          <span className="muted">{c.message?.slice(0, 80)}</span>
                        )}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </>
        )}
      </div>

      <p className="muted small">
        Health: <a href="/api/wake"><code>/api/wake</code></a> · keep-alive: cron-job.org → <code>/api/wake</code> every 10 min
      </p>
    </>
  );
}
