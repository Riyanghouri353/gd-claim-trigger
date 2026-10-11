import { NextResponse } from 'next/server';
import { addWallet, deleteWallet } from '@/lib/wallets';

export const dynamic = 'force-dynamic';

// Wallet vault management. No auth gate by owner decision: the dashboard URL is
// the only barrier. These endpoints can only ADD (given a valid private key) or
// DELETE wallets — they can never READ keys; list/status return names only.

export async function POST(req: Request) {
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
  try {
    const body = await req.json();
    await deleteWallet(body.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'delete failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
