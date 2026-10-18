'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, EmptyState, Pill, fmtAgo, type Status } from '../ui';

interface Leg {
  chain: string;
  status: string;
  wallets_swept: number;
  wallets_skipped: number;
  collected_g: string;
  forwarded_g: string;
  leftover_native: string;
  funding_tx: string | null;
  forward_tx: string | null;
  leftover_tx: string | null;
  sweep_txs: string | null;
  error: string | null;
}

interface HistoryRow {
  id: string;
  label: string;
  address: string;
  created_at: string;
  status: string;
  error: string | null;
  legs: Leg[];
}

interface CollectState {
  running: boolean;
  lastCollection: {
    startedAt: string;
    finishedAt: string;
    collectionAddress: string;
    label: string;
    dryRun: boolean;
    legs: { chain: string; status: string; walletsSwept: number; walletsSkipped: number }[];
  } | null;
  settings: {
    enabledChains: string[];
    mainWalletId: string;
    mainWalletLabel: string | null;
    destination: string;
    auto: boolean;
    dustG: string;
    lastRunAt: string;
  };
  history: HistoryRow[];
}

const ALL_CHAINS = ['celo', 'xdc', 'fuse'];

function fmtG(raw: string, chain: string): string {
  try {
    const v = BigInt(raw);
    const dec = chain === 'fuse' ? 2 : 18;
    let base = BigInt(1);
    for (let i = 0; i < dec; i++) base *= BigInt(10);
    const int = (v / base).toString();
    const frac = (v % base).toString().padStart(dec, '0').replace(/0+$/, '').slice(0, 4);
    return int + (frac ? `.${frac}` : '');
  } catch {
    return raw;
  }
}

export default function Collect({ status: s }: { status: Status }) {
  const [data, setData] = useState<CollectState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/collect', { cache: 'no-store' });
      const d = await res.json();
      if (d.ok) {
        setData(d);
        setErr('');
      } else {
        setErr(d.error || 'Could not load collection status.');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // poll while a collection is running
  useEffect(() => {
    if (!data?.running) return;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [data?.running, load]);

  const trigger = useCallback(
    async (dryRun: boolean) => {
      const what = dryRun ? 'a DRY-RUN collection (gas estimation only, no transfers)' : 'a LIVE collection (moves real G$!)';
      if (!window.confirm(`Start ${what}?`)) return;
      setBusy(true);
      setMsg('');
      try {
        const res = await fetch('/api/collect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun }),
          cache: 'no-store',
        });
        const d = await res.json();
        if (d.ok) {
          setMsg(dryRun ? 'Dry run started — estimating gas, no transfers.' : 'Collection started — running in background.');
          setTimeout(load, 2000);
        } else {
          setMsg(d.error || 'Could not start collection.');
        }
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'request failed');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const saveSettings = useCallback(
    async (patch: Record<string, string>) => {
      setMsg('');
      try {
        const res = await fetch('/api/collect', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
          cache: 'no-store',
        });
        const d = await res.json();
        if (d.ok) {
          setMsg('Settings saved.');
          load();
        } else {
          setMsg(d.error || 'Could not save settings.');
        }
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'request failed');
      }
    },
    [load],
  );

  const [destInput, setDestInput] = useState('');
  const [dustInput, setDustInput] = useState('');
  useEffect(() => {
    if (data?.settings) {
      setDestInput(data.settings.destination);
      setDustInput(data.settings.dustG);
    }
  }, [data?.settings.destination, data?.settings.dustG]);

  const toggleChain = (c: string) => {
    if (!data) return;
    const cur = data.settings.enabledChains;
    const next = cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c];
    saveSettings({ enabledChains: next.join(',') });
  };

  if (loading) return <div className="section"><Card><p className="muted">Loading collection…</p></Card></div>;
  if (err || !data) return <div className="section"><Card title="Collection"><p className="error small">{err || 'unavailable'}</p></Card></div>;

  const st = data.settings;
  return (
    <div className="section">
      <header className="pagehead">
        <div>
          <h1>Collection</h1>
          <p className="muted">
            Sweep G$ → fresh collection wallet → main account, every 3 days
            {st.lastRunAt && <span> · last run {fmtAgo(st.lastRunAt)}</span>}
          </p>
        </div>
        <div className="headbtns">
          <button type="button" className="btn" onClick={() => trigger(true)} disabled={busy || data.running}>
            {busy ? '…' : 'Dry run'}
          </button>
          <button type="button" className="btn primary" onClick={() => trigger(false)} disabled={busy || data.running}>
            {data.running ? 'Collecting…' : 'Collect now'}
          </button>
        </div>
      </header>

      {msg && <p className="muted small" role="status">{msg}</p>}
      {data.running && (
        <Card title="Collection in progress">
          <p className="muted small">Sweeping wallets and forwarding — this takes a few minutes. You can leave this page; it keeps running.</p>
        </Card>
      )}

      <Card title="Settings">
        <div className="field">
          <span>Chains to collect</span>
          <div className="chainpick" role="group" aria-label="Chains">
            {ALL_CHAINS.map((c) => (
              <label key={c} className={`pick${st.enabledChains.includes(c) ? ' on' : ''}`}>
                <input type="checkbox" checked={st.enabledChains.includes(c)} onChange={() => toggleChain(c)} />
                {c}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Main wallet (funds gas, receives G$ by default)</span>
          <select
            value={st.mainWalletId}
            onChange={(e) => saveSettings({ mainWalletId: e.target.value })}
            className="textinput"
          >
            <option value="">— select —</option>
            {s.wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
          {st.mainWalletLabel && <p className="muted small" style={{ marginTop: 6 }}>Current: <strong>{st.mainWalletLabel}</strong></p>}
        </div>
        <div className="field">
          <span>Destination address <span className="muted">(empty = main wallet's address)</span></span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={destInput}
              onChange={(e) => setDestInput(e.target.value)}
              placeholder="0x… (optional override)"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="textinput"
              style={{ flex: 1 }}
            />
            <button type="button" className="btn" onClick={() => saveSettings({ destination: destInput.trim() })}>
              Save
            </button>
          </div>
        </div>
        <div className="field">
          <span>Auto-collect <span className="muted">(after the 22:00 run, every 3 days)</span></span>
          <label className={`pick${st.auto ? ' on' : ''}`}>
            <input type="checkbox" checked={st.auto} onChange={(e) => saveSettings({ auto: e.target.checked ? 'true' : 'false' })} />
            {st.auto ? 'on' : 'off'}
          </label>
        </div>
        <div className="field">
          <span>Dust threshold <span className="muted">(skip wallets below this G$)</span></span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={dustInput}
              onChange={(e) => setDustInput(e.target.value)}
              placeholder="0.01"
              inputMode="decimal"
              className="textinput"
              style={{ width: 120 }}
            />
            <button type="button" className="btn" onClick={() => saveSettings({ dustG: dustInput.trim() || '0.01' })}>
              Save
            </button>
          </div>
        </div>
        <p className="muted small">
          Collection wallet keys are encrypted and kept in the database forever — never deleted,
          so funds are recoverable even if a run fails halfway.
        </p>
      </Card>

      <Card title="History">
        {data.history.length === 0 ? (
          <EmptyState icon="◈" title="No collections yet" hint="Run a dry run first to see gas estimates, then collect for real." />
        ) : (
          <ul className="vaultlist">
            {data.history.map((h) => (
              <li key={h.id} className="vaultrow" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <div>
                    <span className="vaultname">{h.label}</span>
                    <div className="vaultaddr" style={{ cursor: 'default' }}>{h.address}</div>
                  </div>
                  <Pill tone={h.status === 'completed' ? 'ok' : h.status === 'failed' ? 'error' : 'warn'}>
                    {h.status}
                  </Pill>
                </div>
                {h.error && <p className="error small">{h.error}</p>}
                <div className="balgrid">
                  {h.legs.map((l) => (
                    <span key={l.chain} className="balchip" title={l.error || l.status}>
                      <strong>{l.chain}</strong>
                      <span>
                        {' '}swept {l.wallets_swept} · G$ {fmtG(l.forwarded_g || l.collected_g, l.chain)}
                        {l.forward_tx && (
                          <span> · <a href={txUrl(l.chain, l.forward_tx)} target="_blank" rel="noreferrer">tx</a></span>
                        )}
                      </span>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function txUrl(chain: string, hash: string): string {
  if (chain === 'celo') return `https://celoscan.io/tx/${hash}`;
  if (chain === 'fuse') return `https://explorer.fuse.io/tx/${hash}`;
  return `https://xdcscan.io/tx/${hash}`;
}
