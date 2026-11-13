'use client';

import {
  Card,
  ChainBadge,
  Countdown,
  Pill,
  Stat,
  fmtShort,
  useNow,
  type Status,
} from '../ui';

function UtcClock() {
  const now = useNow(1000);
  return (
    <div className="clock" aria-label="Current UTC time">
      <span className="clock-time tabular">{now.toISOString().slice(11, 19)}</span>
      <span className="clock-meta muted small">UTC · {now.toISOString().slice(0, 10)}</span>
    </div>
  );
}

export default function Overview({
  status: s,
  busy,
  msg,
  onTrigger,
  fBusy,
  fMsg,
  onCheckFees,
}: {
  status: Status;
  busy: boolean;
  msg: string;
  onTrigger: () => void;
  fBusy: boolean;
  fMsg: string;
  onCheckFees: () => void;
}) {
  const last = s.lastRun;
  const shortages = (s.gasCheck?.wallets ?? []).flatMap((w) =>
    w.chains.filter((c) => c.low).map((c) => `${w.label} ${c.symbol}`),
  );
  const blockedNow = (s.lastRun?.wallets ?? []).flatMap((w) =>
    w.chains.filter((c) => c.status === 'blocked').map((c) => `${w.label} (${c.chain})`),
  );
  return (
    <div className="section">
      <header className="pagehead">
        <div>
          <h1>Overview</h1>
          <p className="muted">Autonomous parallel claims · every wallet · every chain · at once</p>
        </div>
        <UtcClock />
      </header>

      {shortages.length > 0 && (
        <Card title="⚠ Low gas" className="alertcard">
          <p className="muted small">
            {shortages.join(' · ')} — claims on those chains will fail until topped up manually. See{' '}
            <a href="#/fees">Fee Guard</a> for balances. The faucet funds CELO only.
          </p>
        </Card>
      )}

      {blockedNow.length > 0 && (
        <Card title="⊘ Verification needed" className="alertcard">
          <p className="muted small">
            {blockedNow.join(' · ')} — GoodDollar reports these as not verified, so their claims are blocked
            (not just skipped). Re-verify GoodID in the GoodDollar app.
          </p>
        </Card>
      )}

      <div className="grid4">
        <Stat label="System status" accent={s.running}>
          {s.running ? (
            <span className="live">
              <span className="pulse" aria-hidden="true" />
              Running
            </span>
          ) : (
            <span className="idle">Idle</span>
          )}
        </Stat>
        <Stat label="Next scheduled run">
          <Countdown target={s.nextRunUtc} />
          <div className="stat-sub">{fmtShort(s.nextRunUtc)} UTC</div>
        </Stat>
        <Stat label="Wallets">
          <span className="bignum tabular">{s.walletsConfigured}</span>
          <div className="stat-sub">
            {!s.dbConfigured ? (
              <span className="error">DB not configured</span>
            ) : s.dbError ? (
              <span className="error">{s.dbError.slice(0, 60)}</span>
            ) : (
              <>
                encrypted{' '}
                {s.wallets.every((w) => w.keyOk) ? <span className="ok">✓</span> : <span className="error">key check failed</span>}
              </>
            )}
          </div>
        </Stat>
        <Stat label="Chains">
          <div className="chainrow">
            {s.chains.map((c) => (
              <ChainBadge key={c} chain={c} />
            ))}
          </div>
          <div className="stat-sub">{s.claimTimesUtc.length}× daily · {s.claimTimesUtc.join(", ")} UTC</div>
        </Stat>
      </div>

      <Card title="Manual control">
        <p className="muted small card-desc">Runs all wallets immediately, outside the schedule.</p>
        <div className="btnrow">
          <button
            type="button"
            className="btn primary lg"
            onClick={onTrigger}
            disabled={busy || s.running}
          >
            {busy ? 'Starting…' : s.running ? 'Run in progress…' : '▶ Run claims now'}
          </button>
          <button type="button" className="btn lg" onClick={onCheckFees} disabled={fBusy || s.running}>
            {fBusy ? 'Checking…' : '⛽ Check gas now'}
          </button>
        </div>
        {(msg || fMsg) && (
          <p className="muted small" role="status">
            {msg} {fMsg}
          </p>
        )}
      </Card>

      <Card title="Last run">
        {!last ? (
          <p className="muted small">No runs yet — the first scheduled run will appear here.</p>
        ) : (
          <div className="kvrow">
            <Pill tone="ok">✓ {last.summary.claimed} claimed</Pill>
            <Pill tone="warn">– {last.summary.skipped} skipped</Pill>
            <Pill tone={last.summary.failed > 0 ? 'error' : 'muted'}>✗ {last.summary.failed} failed</Pill>
            <Pill tone={last.summary.blocked > 0 ? 'warn' : 'muted'}>⊘ {last.summary.blocked} blocked</Pill>
            <span className="muted small">
              {fmtShort(last.finishedAt)} UTC · see <a href="#/logs">Logs</a> for details
            </span>
          </div>
        )}
      </Card>

      <details className="card config">
        <summary>Configuration</summary>
        <ul className="cfglist">
          <li>
            gd-claim endpoint{' '}
            <span className={s.gdClaimConfigured ? 'ok' : 'error'}>{s.gdClaimConfigured ? '✓' : '✗'}</span>
          </li>
          <li>
            Keep-alive <code>/api/wake</code> <span className="muted">— hit every 10 min (cron-job.org)</span>
          </li>
          <li>
            Health <a href="/api/health"><code>/api/health</code></a> <span className="muted">— live JSON, no run triggered</span>
          </li>
        </ul>
      </details>
    </div>
  );
}
