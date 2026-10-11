import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { addWallet, deleteWallet } from '@/lib/wallets';

export const dynamic = 'force-dynamic';

// Wallet vault management. Add/delete are gated by ADMIN_SECRET (x-admin-secret
// header) because the dashboard URL is not secret. Keys are encrypted server-side
// with PROJECT_KEY before insert — plaintext keys never touch the database.

function authorized(req: Request): boolean {
  const secret = process.env.ADMIN_SECRET || '';
  if (!secret) return false;
  const got = req.headers.get('x-admin-secret') || '';
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 403 });
  try {
    const body = await req.json();
    await addWallet({ label: body.label, privateKey: body.privateKey, chains: body.chains });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'add failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 403 });
  try {
    const body = await req.json();
    await deleteWallet(body.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'delete failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
