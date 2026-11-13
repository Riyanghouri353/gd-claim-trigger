// Audit trail for vault changes (add / remove / restore). Records WHO did
// WHAT and WHEN — never keys or secrets. Best-effort: an audit failure
// never blocks the vault operation itself.
//
// This exists because 11 wallets disappeared from the vault between
// October and November 2026 with no record of when or how. From now on
// every vault change leaves a row in wallet_audit.

import { supaGet, supaPost } from './supa';

export type AuditAction = 'add' | 'remove' | 'restore' | 'backup';

export interface AuditEntry {
  id?: string;
  createdAt: string;
  action: string;
  walletId: string | null;
  walletLabel: string | null;
  detail: string | null;
}

export async function logWalletAudit(
  action: AuditAction,
  walletId: string | null,
  walletLabel: string | null,
  detail?: string,
): Promise<void> {
  try {
    await supaPost('wallet_audit', [
      { action, wallet_id: walletId, wallet_label: walletLabel, detail: (detail ?? '').slice(0, 300) },
    ]);
  } catch (e) {
    console.error('audit: write failed:', e instanceof Error ? e.message : e);
  }
}

export async function getAuditTrail(limit = 20): Promise<AuditEntry[]> {
  try {
    const rows = await supaGet<
      { id: string; created_at: string; action: string; wallet_id: string | null; wallet_label: string | null; detail: string | null }[]
    >(
      `wallet_audit?select=id,created_at,action,wallet_id,wallet_label,detail&order=created_at.desc&limit=${Math.max(1, Math.min(limit, 100))}`,
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      action: r.action,
      walletId: r.wallet_id,
      walletLabel: r.wallet_label,
      detail: r.detail,
    }));
  } catch (e) {
    console.error('audit: read failed:', e instanceof Error ? e.message : e);
    return [];
  }
}
