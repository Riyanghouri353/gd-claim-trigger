'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, ChainBadge, EmptyState, Modal, Pill, fmtAgo, type Status } from '../ui';

const ALL_CHAINS = ['celo', 'xdc', 'fuse'];

interface ChainBal {
  chain: string;
  native: string | null;
  nativeSymbol: string;
  gd: string | null;
  error?: string;
}

interface WalletBal {
  id: string;
  label: string;
  address: string;
  chains: ChainBal[];
}

interface DeletedWallet {
  id: string;
  label: string;
  chains: string[];
  keyOk: boolean;
  address: string | null;
  deletedAt: string | null;
}

interface AuditEntry {
  id?: string;
  createdAt: string;
  action: string;
  walletId: string | null;
  walletLabel: string | null;
  detail: string | null;
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function WalletModal({
  onClose,
  wLabel,
  setWLabel,
  wKey,
  setWKey,
  wChains,
  setWChains,
  wBusy,
  wError,
  onAdd,
}: {
  onClose: () => void;
  wLabel: string;
  setWLabel: (v: string) => void;
  wKey: string;
  setWKey: (v: string) => void;
  wChains: string[];
  setWChains: (v: string[]) => void;
  wBusy: boolean;
  wError: string;
  onAdd: () => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const toggle = (c: string) =>
    setWChains(wChains.includes(c) ? wChains.filter((x) => x !== c) : [...wChains, c]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onAdd();
  };

  return (
    <Modal title="Add wallet" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted small">
          Stored <strong>encrypted</strong> (AES-256-GCM) — the address is derived from the key
          automatically for balance lookups; the key itself is never shown.
        </p>
        <label className="field">
          <span>Wallet name</span>
          <input
            ref={nameRef}
            value={wLabel}
            onChange={(e) => setWLabel(e.target.value)}
            placeholder="Wallet 1"
            autoComplete="off"
            maxLength={40}
          />
        </label>
        <label className="field">
          <span>Private key</span>
          <input
            type="password"
            value={wKey}
            onChange={(e) => setWKey(e.target.value)}
            placeholder="0x… (64 hex chars)"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <div className="field">
          <span>Chains</span>
          <div className="chainpick" role="group" aria-label="Chains">
            {ALL_CHAINS.map((c) => (
              <label key={c} className={`pick${wChains.includes(c) ? ' on' : ''}`}>
                <input type="checkbox" checked={wChains.includes(c)} onChange={() => toggle(c)} />
                {c}
              </label>
            ))}
          </div>
        </div>
        {wError && (
          <p className="error small" role="alert">
            {wError}
          </p>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={wBusy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={wBusy}>
            {wBusy ? 'Storing…' : 'Store encrypted'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Vault(props: {
  status: Status;
  vaultOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  wLabel: string;
  setWLabel: (v: string) => void;
  wKey: string;
  setWKey: (v: string) => void;
  wChains: string[];
  setWChains: (v: string[]) => void;
  wBusy: boolean;
  wMsg: string;
  wError: string;
  onAdd: () => void;
  onRemove: (id: string, label: string) => void;
  onRestore: (id: string, label: string) => void;
  onBackup: () => void;
}) {
  const { status: s } = props;

  /* ---- removed wallets + audit trail (admin only) ---- */
  const [deleted, setDeleted] = useState<DeletedWallet[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const loadDeleted = useCallback(async () => {
    try {
      const res = await fetch('/api/wallets?deleted=1', { cache: 'no-store' });
      if (!res.ok) {
        setDeleted([]);
        setAudit([]);
        return;
      }
      const data = await res.json();
      setDeleted(data.deleted ?? []);
      setAudit(data.audit ?? []);
    } catch {
      setDeleted([]);
      setAudit([]);
    }
  }, []);

  useEffect(() => {
    if (s.isAdmin) loadDeleted();
    else {
      setDeleted([]);
      setAudit([]);
    }
  }, [s.isAdmin, s.walletsConfigured, loadDeleted]);

  /* ---- live balances (all wallets × chains in parallel, server-side) ---- */
  const [bals, setBals] = useState<WalletBal[] | null>(null);
  const [bLoading, setBLoading] = useState(false);
  const [bError, setBError] = useState('');
  const [bCheckedAt, setBCheckedAt] = useState('');
  const [copied, setCopied] = useState('');

  const loadBalances = useCallback(async () => {
    setBLoading(true);
    setBError('');
    try {
      const res = await fetch('/api/balances', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok) {
        setBals(data.wallets);
        setBCheckedAt(data.checkedAt);
      } else {
        setBError(data.error || 'Could not load balances.');
      }
    } catch (e) {
      setBError(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBLoading(false);
    }
  }, []);

  // Load once when the vault has wallets; reload when the wallet set changes.
  useEffect(() => {
    if (s.dbConfigured && !s.dbError && s.walletsConfigured > 0) loadBalances();
    else setBals(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.dbConfigured, s.walletsConfigured]);

  const copyAddr = useCallback(async (id: string, addr: string) => {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(id);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }, []);

  const balFor = (id: string): WalletBal | undefined => bals?.find((b) => b.id === id);

  return (
    <div className="section">
      <header className="pagehead">
        <div>
          <h1>Wallet Vault</h1>
          <p className="muted">
            {s.walletsConfigured} wallet{s.walletsConfigured === 1 ? '' : 's'} · keys encrypted at rest
            {bCheckedAt && !bLoading && (
              <span> · balances updated {fmtAgo(bCheckedAt)}</span>
            )}
          </p>
        </div>
        <div className="headbtns">
          <button
            type="button"
            className="btn"
            onClick={loadBalances}
            disabled={bLoading || !s.dbConfigured || !!s.dbError || s.walletsConfigured === 0}
            title="Refresh live balances"
          >
            {bLoading ? '⟳ Loading…' : '⟳ Refresh balances'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={props.onBackup}
            disabled={!s.dbConfigured || !!s.dbError}
            title="Download encrypted vault backup (ciphertext only — needs PROJECT_KEY to restore)"
          >
            ⬇ Backup (encrypted)
          </button>
          <button type="button" className="btn primary" onClick={props.onOpen} disabled={!s.dbConfigured || !!s.dbError}>
            + Add wallet
          </button>
        </div>
      </header>

      {!s.dbConfigured ? (
        <Card title="Vault not configured">
          <p className="muted small">
            Set <code>SUPABASE_URL</code>, <code>SUPABASE_SERVICE_KEY</code> and <code>PROJECT_KEY</code> in
            Render → Environment.
          </p>
        </Card>
      ) : s.dbError ? (
        <Card title="Vault error">
          <p className="error small" role="alert">
            {s.dbError}
          </p>
        </Card>
      ) : s.wallets.length === 0 ? (
        <Card>
          <EmptyState
            icon="◈"
            title="No wallets yet"
            hint="Add your first wallet — its key is encrypted before it ever touches the database."
            action={
              <button type="button" className="btn primary" onClick={props.onOpen}>
                + Add wallet
              </button>
            }
          />
        </Card>
      ) : (
        <Card>
          {bError && (
            <p className="error small" role="alert" style={{ marginBottom: 12 }}>
              Balances: {bError}
            </p>
          )}
          <ul className="vaultlist">
            {s.wallets.map((w) => {
              const b = balFor(w.id);
              return (
                <li key={w.id} className="vaultrow">
                  <div className="vaultmain">
                    <span className="vaultname">{w.label}</span>
                    {w.address ? (
                      <button
                        type="button"
                        className="vaultaddr"
                        title={`${w.address} — tap to copy`}
                        onClick={() => copyAddr(w.id, w.address as string)}
                      >
                        {shortAddr(w.address)} {copied === w.id ? '✓ copied' : '⧉'}
                      </button>
                    ) : (
                      <span className="vaultaddr muted">address syncing…</span>
                    )}
                    <span className="chainrow">
                      {w.chains.map((c) => (
                        <ChainBadge key={c} chain={c} />
                      ))}
                    </span>
                    <div className="balgrid">
                      {bLoading && !b ? (
                        <span className="muted small">Loading balances…</span>
                      ) : b ? (
                        b.chains.map((cb) => (
                          <span key={cb.chain} className="balchip" title={cb.error || ''}>
                            <strong>{cb.chain}</strong>
                            {cb.error || cb.native === null ? (
                              <span className="muted"> unavailable</span>
                            ) : (
                              <span>
                                {' '}
                                {cb.native} {cb.nativeSymbol} · <span className="gdtok">G$ {cb.gd}</span>
                              </span>
                            )}
                          </span>
                        ))
                      ) : null}
                    </div>
                  </div>
                  <div className="vaultside">
                    <Pill tone={w.keyOk ? 'ok' : 'error'} title={w.keyOk ? 'Decrypts with PROJECT_KEY' : 'Decryption failed'}>
                      {w.keyOk ? '🔒 secured' : '🔒 failed'}
                    </Pill>
                    <button
                      type="button"
                      className="iconbtn"
                      title={`Remove ${w.label}`}
                      aria-label={`Remove ${w.label}`}
                      onClick={() => props.onRemove(w.id, w.label)}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {props.wMsg && (
        <p className="muted small" role="status">
          {props.wMsg}
        </p>
      )}

      {s.isAdmin && (deleted.length > 0 || audit.length > 0) && (
        <Card title="Removed wallets & audit trail">
          {deleted.length === 0 ? (
            <p className="muted small">No removed wallets — removals stay recoverable here.</p>
          ) : (
            <ul className="vaultlist">
              {deleted.map((w) => (
                <li key={w.id} className="vaultrow">
                  <div className="vaultmain">
                    <span className="vaultname">{w.label}</span>
                    {w.address && <span className="vaultaddr muted">{shortAddr(w.address)}</span>}
                    <span className="muted small">removed {w.deletedAt ? fmtAgo(w.deletedAt) : ''}</span>
                  </div>
                  <div className="vaultside">
                    <button type="button" className="btn" onClick={() => props.onRestore(w.id, w.label)}>
                      ↩ Restore
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {audit.length > 0 && (
            <ul className="muted small" style={{ marginTop: 14 }}>
              {audit.map((a, i) => (
                <li key={a.id ?? i}>
                  {fmtAgo(a.createdAt)} · <strong>{a.action}</strong> {a.walletLabel ? `· ${a.walletLabel}` : ''}{' '}
                  {a.detail ? `· ${a.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {props.vaultOpen && (
        <WalletModal
          onClose={props.onClose}
          wLabel={props.wLabel}
          setWLabel={props.setWLabel}
          wKey={props.wKey}
          setWKey={props.setWKey}
          wChains={props.wChains}
          setWChains={props.setWChains}
          wBusy={props.wBusy}
          wError={props.wError}
          onAdd={props.onAdd}
        />
      )}
    </div>
  );
}
