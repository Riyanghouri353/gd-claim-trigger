'use client';

import { Card, EmptyState, Pill, fmtAgo, type FeeWallet, type Status } from '../ui';

function feeState(w: FeeWallet, threshold: number): { tone: 'ok' | 'error'; label: string } {
  if (w.toppedUp) return { tone: 'ok', label: 'Topped up' };
  if (w.balanceBefore == null) return { tone: 'error', label: 'Check failed' };
  if (w.balanceBefore < threshold) return { tone: 'error', label: 'Low — faucet failed' };
  return { tone: 'ok', label: 'Healthy' };
}

export default function FeeGuard({
  status: s,
  fBusy,
  fMsg,
  onCheckFees,
}: {
  status: Status;
  fBusy: boolean;
  fMsg: string;
  onCheckFees: () => void;
}) {
  const fc = s.feeCheck;
  return (
    <div className="section">
      <header className="pagehead">
        <div>
          <h1>Fee Guard</h1>
          <p className="muted">
            Daily CELO check · tops up below <span className="mono">{s.feeThreshold} CELO</span> via GoodDollar
            faucet
          </p>
        </div>
        <button type="button" className="btn" onClick={onCheckFees} disabled={fBusy || s.running}>
          {fBusy ? 'Checking…' : '⛽ Check gas now'}
        </button>
      </header>

      {fMsg && (
        <p className="muted small" role="status">
          {fMsg}
        </p>
      )}

      {!fc ? (
        <Card>
          <EmptyState
            icon="⛽"
            title="No fee check yet"
            hint="Runs automatically at the start of every scheduled or manual run — or trigger one now."
          />
        </Card>
      ) : (
        <Card
          title="Gas balances"
          action={<span className="muted small">checked {fmtAgo(fc.checkedAt)}</span>}
        >
          <ul className="feelist">
            {fc.wallets.map((w) => {
              const st = feeState(w, fc.threshold);
              return (
                <li key={w.label} className="feerow">
                  <span className="feename">{w.label}</span>
                  <span className="feevalue mono tabular" aria-label={`${w.label} CELO balance`}>
                    {w.balanceBefore == null ? (
                      <span className="muted">—</span>
                    ) : w.toppedUp && w.balanceAfter != null ? (
                      <>
                        {w.balanceBefore.toFixed(4)} <span className="muted">→</span>{' '}
                        <strong>{w.balanceAfter.toFixed(4)}</strong>
                      </>
                    ) : (
                      <>{w.balanceBefore.toFixed(4)}</>
                    )}
                  </span>
                  <Pill tone={st.tone}>{st.label}</Pill>
                </li>
              );
            })}
          </ul>
          {fc.wallets.some((w) => w.message && !w.toppedUp && w.balanceBefore != null) && (
            <p className="muted small foot-note" role="note">
              {fc.wallets.find((w) => w.message && !w.toppedUp)?.message}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
