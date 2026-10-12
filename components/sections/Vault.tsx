'use client';

import { useEffect, useRef } from 'react';
import { Card, ChainBadge, EmptyState, Modal, Pill, type Status } from '../ui';

const ALL_CHAINS = ['celo', 'xdc', 'fuse'];

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
          Stored <strong>encrypted</strong> (AES-256-GCM) — only the wallet name is ever shown, never the key.
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
}) {
  const { status: s } = props;
  return (
    <div className="section">
      <header className="pagehead">
        <div>
          <h1>Wallet Vault</h1>
          <p className="muted">
            {s.walletsConfigured} wallet{s.walletsConfigured === 1 ? '' : 's'} · keys encrypted at rest
          </p>
        </div>
        <button type="button" className="btn primary" onClick={props.onOpen} disabled={!s.dbConfigured || !!s.dbError}>
          + Add wallet
        </button>
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
          <ul className="vaultlist">
            {s.wallets.map((w) => (
              <li key={w.id} className="vaultrow">
                <div className="vaultmain">
                  <span className="vaultname">{w.label}</span>
                  <span className="chainrow">
                    {w.chains.map((c) => (
                      <ChainBadge key={c} chain={c} />
                    ))}
                  </span>
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
            ))}
          </ul>
        </Card>
      )}

      {props.wMsg && (
        <p className="muted small" role="status">
          {props.wMsg}
        </p>
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
