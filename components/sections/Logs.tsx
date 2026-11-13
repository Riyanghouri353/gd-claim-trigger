'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Card,
  ChainBadge,
  CopyBtn,
  EmptyState,
  Pill,
  SegmentedBar,
  StatusPill,
  fmt,
  fmtAgo,
  type HistoryRun,
  type Status,
} from '../ui';

function durationSec(startedAt: string, finishedAt: string): number {
  return Math.max(1, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
}

function problemLines(run: HistoryRun): { wallet: string; chain: string; status: string; message: string }[] {
  const out: { wallet: string; chain: string; status: string; message: string }[] = [];
  for (const w of run.wallets) {
    for (const c of w.chains) {
      if (c.status === 'failed' || c.status === 'blocked') {
        out.push({ wallet: w.label, chain: c.chain, status: c.status, message: c.message ?? '' });
      }
    }
  }
  return out;
}

export default function Logs({ status: s }: { status: Status }) {
  const last = s.lastRun;
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [histError, setHistError] = useState('');

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/history?limit=10', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok) setHistory(data.runs);
      else setHistError(data.error || 'Could not load history.');
    } catch (e) {
      setHistError(e instanceof Error ? e.message : 'request failed');
    }
  }, []);

  useEffect(() => {
    loadHistory();
    const t = setInterval(loadHistory, 60_000);
    return () => clearInterval(t);
  }, [loadHistory, last?.startedAt]);

  return (
    <div className="section">
      <header className="pagehead">
        <div>
          <h1>Execution Logs</h1>
          <p className="muted">Per-wallet, per-chain results from the latest run, plus run history</p>
        </div>
      </header>

      {!last ? (
        <Card>
          <EmptyState
            icon="◷"
            title="No runs yet"
            hint="The first scheduled run will appear here — or trigger one manually from Overview."
          />
        </Card>
      ) : (
        <>
          <Card
            title="Latest run"
            action={
              <span className="muted small tabular">
                {fmt(last.startedAt)} → {fmt(last.finishedAt)} · {durationSec(last.startedAt, last.finishedAt)}s
              </span>
            }
          >
            <div className="summaryrow">
              <Pill tone="ok">✓ {last.summary.claimed} claimed</Pill>
              <Pill tone="warn">– {last.summary.skipped} skipped</Pill>
              <Pill tone={last.summary.failed > 0 ? 'error' : 'muted'}>✗ {last.summary.failed} failed</Pill>
              <Pill tone={last.summary.blocked > 0 ? 'warn' : 'muted'}>⊘ {last.summary.blocked} blocked</Pill>
            </div>
            <SegmentedBar
              claimed={last.summary.claimed}
              skipped={last.summary.skipped}
              failed={last.summary.failed}
              blocked={last.summary.blocked}
            />
          </Card>

          <div className="logcards">
            {last.wallets.map((w) => (
              <Card key={w.label} title={w.label} className="logcard">
                <ul className="chainresults">
                  {w.chains.map((c) => (
                    <li key={`${w.label}-${c.chain}`} className="chainresult">
                      <div className="cr-main">
                        <ChainBadge chain={c.chain} />
                        <StatusPill status={c.status} />
                        {c.fundedGas && <Pill tone="info">⛽ funded</Pill>}
                        <span className="cr-amount mono tabular">
                          {c.amount ? `${c.amount} G$` : '—'}
                        </span>
                      </div>
                      {c.txHash && c.explorerUrl ? (
                        <div className="cr-detail">
                          <a href={c.explorerUrl} target="_blank" rel="noreferrer" className="txlink mono">
                            {c.txHash.slice(0, 12)}…{c.txHash.slice(-6)}
                          </a>
                          <CopyBtn text={c.txHash} />
                        </div>
                      ) : (
                        c.message && (
                          <details className="cr-detail">
                            <summary className="muted small">Details</summary>
                            <p className="muted small wraptext">{c.message}</p>
                          </details>
                        )
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </>
      )}

      <Card title="Run history" action={<span className="muted small">last {history.length} runs · persists across restarts</span>}>
        {histError ? (
          <p className="error small" role="alert">{histError}</p>
        ) : history.length === 0 ? (
          <p className="muted small">No recorded runs yet — history starts accumulating from the next run.</p>
        ) : (
          <ul className="histlist">
            {history.map((run) => {
              const problems = problemLines(run);
              return (
                <li key={`${run.startedAt}-${run.slotLabel}`} className="histrow">
                  <div className="hist-main">
                    <span className="mono tabular">{fmt(run.startedAt)}</span>
                    <span className="muted small">{fmtAgo(run.startedAt)} · {run.slotLabel} · {durationSec(run.startedAt, run.finishedAt)}s</span>
                    <span className="hist-pills">
                      <Pill tone="ok">✓ {run.summary.claimed}</Pill>
                      <Pill tone="warn">– {run.summary.skipped}</Pill>
                      <Pill tone={run.summary.failed > 0 ? 'error' : 'muted'}>✗ {run.summary.failed}</Pill>
                      <Pill tone={run.summary.blocked > 0 ? 'warn' : 'muted'}>⊘ {run.summary.blocked}</Pill>
                    </span>
                  </div>
                  {problems.length > 0 && (
                    <details className="hist-detail">
                      <summary className="muted small">{problems.length} problem{problems.length === 1 ? '' : 's'}</summary>
                      <ul className="muted small wraptext">
                        {problems.map((p, i) => (
                          <li key={i}>
                            <strong>{p.wallet}</strong> [{p.chain}] {p.status}: {p.message}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
