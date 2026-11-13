'use client';

import { Card, ChainBadge, EmptyState, Pill, fmtAgo, type FeeWallet, type Status } from '../ui';

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
  const gas = s.gasCheck ?? null;
  return (
    <div className="section">
      <header className="pagehead">
        <div>
          <h1>Fee Guard</h1>
          <p className="muted">
            Daily CELO check · tops up below <span className="mono">{s.feeThreshold} CELO</span> via GoodDollar
            faucet · plus all-chain gas monitoring (FUSE/XDC need manual top-ups)
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

      {gas ? (
        <Card
          title="All-chain gas monitor"
          action={<span className="muted small">checked {fmtAgo(gas.checkedAt)} · RPC balances, no keys used</span>}
        >
          <ul className="gaslist">
            {gas.wallets.map((w) => (
              <li key={w.label} className="gasrow">
                <span className="feename">{w.label}</span>
                <span className="gaschips">
                  {w.chains.map((c) => (
                    <span key={c.chain} className="gaschip" title={c.error || `${c.symbol} balance vs ${c.threshold} threshold`}>
                      <ChainBadge chain={c.chain} />
                      <span className="mono tabular">
                        {c.balance == null ? '—' : c.balance.toFixed(4)} {c.symbol}
                      </span>
                      {c.error ? (
                        <Pill tone="error">Check failed</Pill>
                      ) : c.low ? (
                        <Pill tone="error">Low (&lt; {c.threshold})</Pill>
                      ) : (
                        <Pill tone="ok">OK</Pill>
                      )}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small foot-note">
            Low FUSE/XDC wallets fail their claims until topped up manually — the faucet funds CELO only.
          </p>
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon="⛽"
            title="No gas check yet"
            hint="Runs automatically at the start of every scheduled or manual run — or trigger one now."
          />
        </Card>
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
          title="CELO fee guard"
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
