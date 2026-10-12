'use client';

import { useCallback, useEffect, useState } from 'react';
import { Spinner, useStatus } from './ui';
import Overview from './sections/Overview';
import Vault from './sections/Vault';
import FeeGuard from './sections/FeeGuard';
import Logs from './sections/Logs';

/* ------------------------------------------------------------------ */
/* Nav icons (inline SVG, stroke = currentColor)                        */
/* ------------------------------------------------------------------ */

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const TABS = [
  { id: 'overview', label: 'Overview', icon: <Icon d="M4 4h7v7H4zM13 4h7v4h-7zM13 11h7v9h-7zM4 14h7v6H4z" /> },
  { id: 'vault', label: 'Vault', icon: <Icon d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z M9.5 12l2 2 3.5-4" /> },
  { id: 'fees', label: 'Fee Guard', icon: <Icon d="M5 19a9 9 0 1 1 14 0 M12 15l4-5 M12 15h.01" /> },
  { id: 'logs', label: 'Logs', icon: <Icon d="M8 6h13M8 12h13M8 18h13 M3.5 6h.01M3.5 12h.01M3.5 18h.01" /> },
] as const;

type TabId = (typeof TABS)[number]['id'];

function tabFromHash(): TabId {
  if (typeof window === 'undefined') return 'overview';
  const h = window.location.hash.replace(/^#\/?/, '');
  return TABS.some((t) => t.id === h) ? (h as TabId) : 'overview';
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

export default function AppShell() {
  const { status, reload } = useStatus(5000);
  const [tab, setTab] = useState<TabId>(tabFromHash);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((id: TabId) => {
    window.location.hash = `#/${id}`;
    setTab(id);
  }, []);

  /* ---- manual run (POST /api/trigger — unchanged) ---- */
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const manualTrigger = useCallback(async () => {
    if (!window.confirm('Run claims now for all wallets, outside the schedule?')) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/trigger', { method: 'POST' });
      const data = await res.json();
      setMsg(
        data.ok ? 'Run started — results appear in Logs as chains complete.' : `Could not start: ${data.error}`,
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
      reload();
    }
  }, [reload]);

  /* ---- fee check (POST /api/fees — unchanged) ---- */
  const [fBusy, setFBusy] = useState(false);
  const [fMsg, setFMsg] = useState('');
  const checkFeesNow = useCallback(async () => {
    setFMsg('');
    setFBusy(true);
    try {
      const res = await fetch('/api/fees', { method: 'POST' });
      const data = await res.json();
      setFMsg(
        data.ok
          ? 'Fee check started in the background — results appear below shortly.'
          : `✗ ${data.error || 'failed'}`,
      );
    } catch (e) {
      setFMsg(`✗ ${e instanceof Error ? e.message : 'request failed'}`);
    } finally {
      setFBusy(false);
      reload();
    }
  }, [reload]);

  /* ---- vault (POST/DELETE /api/wallets — unchanged payloads) ---- */
  const [vaultOpen, setVaultOpen] = useState(false);
  const [wLabel, setWLabel] = useState('');
  const [wKey, setWKey] = useState('');
  const [wChains, setWChains] = useState<string[]>(['celo', 'xdc', 'fuse']);
  const [wBusy, setWBusy] = useState(false);
  const [wMsg, setWMsg] = useState('');
  const [wError, setWError] = useState('');

  const resetVaultForm = useCallback(() => {
    setWLabel('');
    setWKey('');
    setWChains(['celo', 'xdc', 'fuse']);
    setWMsg('');
    setWError('');
    setWBusy(false);
  }, []);

  const openVaultModal = useCallback(() => {
    resetVaultForm();
    setVaultOpen(true);
  }, [resetVaultForm]);

  const addWallet = useCallback(async () => {
    setWError('');
    setWMsg('');
    if (!wLabel.trim()) {
      setWError('Give the wallet a name.');
      return;
    }
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(wKey.trim())) {
      setWError('Private key must be 64 hex characters (0x prefix optional).');
      return;
    }
    if (wChains.length === 0) {
      setWError('Select at least one chain.');
      return;
    }
    setWBusy(true);
    try {
      const res = await fetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: wLabel.trim(), privateKey: wKey.trim(), chains: wChains }),
      });
      const data = await res.json();
      if (data.ok) {
        setVaultOpen(false);
        resetVaultForm();
      } else {
        setWError(data.error || 'Could not store the wallet.');
      }
    } catch (e) {
      setWError(e instanceof Error ? e.message : 'request failed');
    } finally {
      setWBusy(false);
      reload();
    }
  }, [wLabel, wKey, wChains, reload, resetVaultForm]);

  const removeWallet = useCallback(
    async (id: string, label: string) => {
      if (!window.confirm(`Remove "${label}" from the vault?`)) return;
      try {
        const res = await fetch('/api/wallets', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        const data = await res.json();
        if (!data.ok) window.alert(`Could not remove: ${data.error || 'failed'}`);
      } catch (e) {
        window.alert(e instanceof Error ? e.message : 'request failed');
      } finally {
        reload();
      }
    },
    [reload],
  );

  if (!status) {
    return (
      <div className="shell">
        <Spinner label="Connecting to runner…" />
      </div>
    );
  }

  const nav = (vertical: boolean) => (
    <nav className={vertical ? 'sidenav' : 'bottomnav'} aria-label="Sections">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`navitem${tab === t.id ? ' active' : ''}`}
          aria-current={tab === t.id ? 'page' : undefined}
          onClick={() => go(t.id)}
        >
          <span className="navicon">{t.icon}</span>
          <span className="navlabel">{t.label}</span>
          {t.id === 'logs' && status.running && <span className="navdot" aria-label="run in progress" />}
        </button>
      ))}
    </nav>
  );

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Sidebar">
        <button type="button" className="brand" onClick={() => go('overview')} aria-label="G$ Claim Runner home">
          <span className="brand-mark" aria-hidden="true">
            G$
          </span>
          <span className="brand-text">
            <strong>Claim Runner</strong>
            <small className={status.running ? 'live' : 'muted'}>{status.running ? '● running' : 'autopilot'}</small>
          </span>
        </button>
        {nav(true)}
        <div className="sidefoot">
          <span className="muted small">daily at {status.claimTimeUtc} UTC</span>
        </div>
      </aside>

      <div className="main">
        <main className="content">
          {tab === 'overview' && (
            <Overview
              status={status}
              busy={busy}
              msg={msg}
              onTrigger={manualTrigger}
              fBusy={fBusy}
              fMsg={fMsg}
              onCheckFees={checkFeesNow}
            />
          )}
          {tab === 'vault' && (
            <Vault
              status={status}
              vaultOpen={vaultOpen}
              onOpen={openVaultModal}
              onClose={() => setVaultOpen(false)}
              wLabel={wLabel}
              setWLabel={setWLabel}
              wKey={wKey}
              setWKey={setWKey}
              wChains={wChains}
              setWChains={setWChains}
              wBusy={wBusy}
              wMsg={wMsg}
              wError={wError}
              onAdd={addWallet}
              onRemove={removeWallet}
            />
          )}
          {tab === 'fees' && (
            <FeeGuard status={status} fBusy={fBusy} fMsg={fMsg} onCheckFees={checkFeesNow} />
          )}
          {tab === 'logs' && <Logs status={status} />}
        </main>
      </div>

      {nav(false)}
    </div>
  );
}
