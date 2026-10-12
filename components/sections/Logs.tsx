'use client';

import {
  Card,
  ChainBadge,
  CopyBtn,
  EmptyState,
  Pill,
  SegmentedBar,
  StatusPill,
  fmt,
  type Status,
} from '../ui';

function durationSec(startedAt: string, finishedAt: string): number {
  return Math.max(1, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
}

export default function Logs({ status: s }: { status: Status }) {
  const last = s.lastRun;
  return (
    <div className="section">
      <header className="pagehead">
        <div>
          <h1>Execution Logs</h1>
          <p className="muted">Per-wallet, per-chain results from the latest run</p>
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
            </div>
            <SegmentedBar
              claimed={last.summary.claimed}
              skipped={last.summary.skipped}
              failed={last.summary.failed}
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
    </div>
  );
}
