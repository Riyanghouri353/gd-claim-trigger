'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Engine {
  running: boolean;
  jobId: string | null;
  total: string;
  checked: string;
  found: number;
  ratePerSec: number;
  startedAt: string | null;
  lastError: string | null;
  thresholdUsdt: number;
  unknownCount: number;
  suffixFastPath: boolean;
}
interface Job {
  id: string;
  unknown_count: number;
  total_combinations: string;
  threshold_usdt: string;
  checked_count: string;
  found_count: number;
  rate_per_sec: string;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
interface Hit {
  id: string;
  job_id: string | null;
  address: string;
  usdt_balance: string;
  created_at: string;
}

const fmt = (n: string | number) => Number(n).toLocaleString('en-US');

export default function RecoveryPage() {
  const [prefix, setPrefix] = useState('');
  const [missing, setMissing] = useState(4);
  const [template, setTemplate] = useState('');
  const [threshold, setThreshold] = useState('0.1');
  const [engine, setEngine] = useState<Engine | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/recovery', { cache: 'no-store' });
      const j = await res.json();
      if (j.engine) setEngine(j.engine);
      if (Array.isArray(j.jobs)) setJobs(j.jobs);
      if (Array.isArray(j.hits)) setHits(j.hits);
      if (!j.ok && j.error) setError(j.error);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    refresh();
    poll.current = setInterval(refresh, 2000);
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [refresh]);

  // Build template from prefix + missing-count helper
  useEffect(() => {
    const clean = prefix.trim().toLowerCase().replace(/^0x/, '');
    if (/^[0-9a-f]*$/.test(clean) && clean.length + missing === 64) {
      setTemplate(clean + '?'.repeat(missing));
    }
  }, [prefix, missing]);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/recovery', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'failed');
      if (j.engine) setEngine(j.engine);
      if (action === 'reveal' && j.hit) {
        setRevealed((r) => ({ ...r, [String(extra.hitId)]: j.hit.privateKey }));
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  const total = engine ? BigInt(engine.total || '0') : BigInt(0);
  const checked = engine ? BigInt(engine.checked || '0') : BigInt(0);
  const pct = total > BigInt(0) ? Number((checked * BigInt(10000)) / total) / 100 : 0;
  const remaining = total - checked;
  const etaSec = engine && engine.ratePerSec > 0 ? Number(remaining) / engine.ratePerSec : null;
  const combos = template ? Math.pow(16, (template.match(/\?/g) || []).length) : 0;

  const s: Record<string, React.CSSProperties> = {
    wrap: { maxWidth: 900, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif', color: '#e7e7e7', background: '#0c0f14', minHeight: '100vh' },
    card: { background: '#131720', border: '1px solid #232a38', borderRadius: 12, padding: 18, marginBottom: 16 },
    input: { width: '100%', background: '#0c0f14', border: '1px solid #2b3345', borderRadius: 8, color: '#e7e7e7', padding: '10px 12px', fontFamily: 'monospace', fontSize: 13, boxSizing: 'border-box' },
    btn: { background: '#2563eb', color: '#fff', border: 0, borderRadius: 8, padding: '10px 18px', cursor: 'pointer', fontWeight: 600 },
    btnStop: { background: '#dc2626', color: '#fff', border: 0, borderRadius: 8, padding: '10px 18px', cursor: 'pointer', fontWeight: 600 },
    btnGhost: { background: '#1e2534', color: '#cbd5e1', border: '1px solid #2b3345', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' },
    label: { display: 'block', fontSize: 12, color: '#94a3b8', margin: '12px 0 6px' },
    big: { fontSize: 26, fontWeight: 700 },
    small: { fontSize: 12, color: '#94a3b8' },
  };

  return (
    <div style={s.wrap}>
      <h1 style={{ fontSize: 22, margin: '4px 0' }}>🔑 Wallet Key Recovery — USDT (BEP20)</h1>
      <p style={s.small}>
        Paste the part of your private key you still have, mark each lost hex digit with <b>?</b> (or use the helper below). The server tries every
        combination, derives each wallet, and checks its BSC USDT balance. Any wallet with balance ≥ your threshold is saved — encrypted — to
        Supabase so you can check it later. The scan runs continuously until you stop it.
      </p>

      {error && <div style={{ ...s.card, borderColor: '#dc2626', color: '#fca5a5' }}>{error}</div>}

      <div style={s.card}>
        <span style={s.label}>Helper — known prefix + how many last digits are lost</span>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input style={{ ...s.input, flex: '1 1 480px' }} placeholder="known part of your key (hex, without the lost digits)" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          <select value={missing} onChange={(e) => setMissing(Number(e.target.value))} style={{ ...s.input, width: 130 }}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                last {n} lost
              </option>
            ))}
          </select>
        </div>
        <span style={s.label}>Template (64 chars — edit directly if the lost digits are not at the end)</span>
        <input style={s.input} placeholder="e.g. 9f2c…ab????" value={template} onChange={(e) => setTemplate(e.target.value)} />
        <span style={s.label}>Save wallet when USDT balance is at least (USDT)</span>
        <input style={{ ...s.input, width: 160 }} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        {template && (
          <p style={s.small}>
            Combinations to try: <b>{fmt(combos)}</b>
            {combos >= 16777216 ? ' — that is a very long scan (days+). Fewer missing digits finish much faster.' : ''}
          </p>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          {!engine?.running ? (
            <button style={s.btn} disabled={busy || template.length !== 64} onClick={() => act('start', { template, thresholdUsdt: Number(threshold) })}>
              ▶ Start scan
            </button>
          ) : (
            <button style={s.btnStop} disabled={busy} onClick={() => act('stop')}>
              ⏹ Stop scan
            </button>
          )}
        </div>
      </div>

      {engine && (engine.running || checked > BigInt(0)) && (
        <div style={s.card}>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            <div>
              <div style={s.big}>{engine.running ? 'Scanning…' : 'Stopped / done'}</div>
              <div style={s.small}>{engine.suffixFastPath ? 'Fast path: suffix increments' : 'Full-derivation path'}</div>
            </div>
            <div>
              <div style={s.big}>{fmt(engine.checked)}</div>
              <div style={s.small}>of {fmt(engine.total)} checked ({pct}%)</div>
            </div>
            <div>
              <div style={s.big}>{engine.ratePerSec}/s</div>
              <div style={s.small}>wallets checked per second</div>
            </div>
            <div>
              <div style={s.big}>{engine.found}</div>
              <div style={s.small}>wallets found ≥ {engine.thresholdUsdt} USDT</div>
            </div>
            <div>
              <div style={s.big}>{etaSec ? (etaSec > 3600 ? `${(etaSec / 3600).toFixed(1)} h` : etaSec > 60 ? `${(etaSec / 60).toFixed(1)} min` : `${Math.round(etaSec)} s`) : '—'}</div>
              <div style={s.small}>estimated time left</div>
            </div>
          </div>
          <div style={{ height: 10, background: '#0c0f14', borderRadius: 6, marginTop: 14, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: '#2563eb', transition: 'width .5s' }} />
          </div>
          {engine.lastError && <p style={{ ...s.small, color: '#fca5a5' }}>Last RPC note: {engine.lastError}</p>}
        </div>
      )}

      <div style={s.card}>
        <h3 style={{ marginTop: 0 }}>💰 Found wallets (saved in Supabase, key encrypted)</h3>
        {hits.length === 0 && <p style={s.small}>Nothing found yet.</p>}
        {hits.map((h) => (
          <div key={h.id} style={{ borderTop: '1px solid #232a38', padding: '10px 0' }}>
            <div style={{ fontFamily: 'monospace', fontSize: 13 }}>{h.address}</div>
            <div style={s.small}>
              {Number(h.usdt_balance).toLocaleString()} USDT · found {new Date(h.created_at).toLocaleString()}
            </div>
            {revealed[h.id] ? (
              <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', background: '#0c0f14', padding: 8, borderRadius: 6, marginTop: 6 }}>{revealed[h.id]}</div>
            ) : (
              <button style={{ ...s.btnGhost, marginTop: 6 }} disabled={busy} onClick={() => act('reveal', { hitId: h.id })}>
                Reveal private key
              </button>
            )}
          </div>
        ))}
      </div>

      <div style={s.card}>
        <h3 style={{ marginTop: 0 }}>Scan history</h3>
        {jobs.length === 0 && <p style={s.small}>No scans yet.</p>}
        {jobs.map((j) => (
          <div key={j.id} style={{ borderTop: '1px solid #232a38', padding: '8px 0', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <span style={s.small}>
              {new Date(j.created_at).toLocaleString()} · {j.unknown_count} unknown digits · {fmt(j.checked_count)} / {fmt(j.total_combinations)} checked · {j.found_count} found · <b>{j.status}</b>
              {j.status !== 'done' && j.status !== 'running' ? '' : ''}
            </span>
            {!engine?.running && j.status !== 'done' && BigInt(j.checked_count) < BigInt(j.total_combinations) && (
              <button style={s.btnGhost} disabled={busy} onClick={() => act('resume', { jobId: j.id })}>
                Resume
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
