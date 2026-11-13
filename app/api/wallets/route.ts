import { NextResponse } from 'next/server';
import {
  addWallet,
  deleteWallet,
  getVaultBackup,
  listDeletedWallets,
  restoreWallet,
} from '@/lib/wallets';
import { getAuditTrail, logWalletAudit } from '@/lib/audit';
import { isAdminConfigured, isAdminRequest } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

// Wallet vault management. ADMIN-ONLY since Nov 2026: these endpoints used
// to be completely open, so anyone who found the URL could delete wallets
// (11 wallets vanished Oct→Nov with no record of how). Reads stay open via
// /api/status; everything here needs the admin session or Bearer token.
//
// POST {label, privateKey, chains} — add (encrypted at rest, audit-logged).
// POST {action:'restore', id} — restore a soft-removed wallet.
// DELETE {id} — SOFT-remove: sets deleted_at, row + encrypted key kept.
// GET ?deleted=1 — removed wallets + recent audit trail.
// GET ?backup=1 — encrypted vault backup download (ciphertext only).
// Keys are NEVER returned by any of these endpoints.

async function guard(req: Request): Promise<NextResponse | null> {
  if (!isAdminConfigured()) {
    return NextResponse.json({ ok: false, error: 'admin password is not configured on the server' }, { status: 503 });
  }
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ ok: false, error: 'admin login required' }, { status: 401 });
  }
  return null;
}

export async function POST(req: Request) {
  const denied = await guard(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    if (body.action === 'restore') {
      const label = await restoreWallet(body.id);
      await logWalletAudit('restore', body.id, label || null, 'restored from dashboard');
      return NextResponse.json({ ok: true, restored: label });
    }
    const id = await addWallet({ label: body.label, privateKey: body.privateKey, chains: body.chains });
    await logWalletAudit('add', id || null, body.label, `chains: ${(body.chains || []).join(',')}`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'add failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const denied = await guard(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const label = await deleteWallet(body.id);
    await logWalletAudit('remove', body.id, label || null, 'soft-removed (recoverable via restore)');
    return NextResponse.json({ ok: true, removed: label });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'delete failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}

export async function GET(req: Request) {
  const denied = await guard(req);
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  try {
    if (searchParams.get('deleted') === '1') {
      const [deleted, audit] = await Promise.all([listDeletedWallets(), getAuditTrail(20)]);
      return NextResponse.json({ ok: true, deleted, audit });
    }
    if (searchParams.get('backup') === '1') {
      const wallets = await getVaultBackup();
      await logWalletAudit('backup', null, null, `${wallets.length} wallets exported (encrypted)`);
      const payload = {
        exportedAt: new Date().toISOString(),
        note: 'Encrypted vault backup. Ciphertext only — restoring requires PROJECT_KEY. Never share this file with anyone who has PROJECT_KEY.',
        count: wallets.length,
        wallets,
      };
      return new NextResponse(JSON.stringify(payload, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="gd-claim-vault-backup-${new Date().toISOString().slice(0, 10)}.json"`,
        },
      });
    }
    return NextResponse.json({ ok: false, error: 'use ?deleted=1 or ?backup=1' }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'request failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
