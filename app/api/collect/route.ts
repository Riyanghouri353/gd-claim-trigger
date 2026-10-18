import { NextResponse } from 'next/server';
import { getLastCollection, isCollecting, runCollection } from '@/lib/collect';
import { getCollectionSettings, setSetting } from '@/lib/settings';
import { isDbConfigured, listWallets, supaEnv } from '@/lib/wallets';

export const dynamic = 'force-dynamic';

// GET: collection status — settings, running state, last run, history.
// POST: trigger a collection run (manual). { dryRun?: boolean }
//   Dry run = gas estimation only, no broadcasts (still saves a labeled DB row).
async function readHistory(): Promise<unknown[]> {
  const { url, key } = supaEnv();
  const res = await fetch(
    `${url}/rest/v1/collection_wallets?select=id,label,address,created_at,status,error&order=created_at.desc&limit=20`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store' },
  );
  if (!res.ok) return [];
  const wallets = (await res.json()) as Record<string, unknown>[];
  const out = [];
  for (const w of wallets) {
    const legsRes = await fetch(
      `${url}/rest/v1/collection_legs?collection_id=eq.${w.id}&select=chain,status,wallets_swept,wallets_skipped,collected_g,forwarded_g,leftover_native,funding_tx,forward_tx,leftover_tx,sweep_txs,error,created_at&order=created_at`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store' },
    );
    out.push({ ...w, legs: legsRes.ok ? await legsRes.json() : [] });
  }
  return out;
}

export async function GET() {
  if (!isDbConfigured()) return NextResponse.json({ ok: false, error: 'not configured' }, { status: 400 });
  try {
    const [settings, wallets, history] = await Promise.all([
      getCollectionSettings(),
      listWallets(),
      readHistory(),
    ]);
    const mainWallet = wallets.find((w) => w.id === settings.mainWalletId);
    return NextResponse.json({
      ok: true,
      running: isCollecting(),
      lastCollection: getLastCollection(),
      settings: { ...settings, mainWalletLabel: mainWallet?.label ?? null, mainWalletAddress: mainWallet?.address ?? null },
      history,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!isDbConfigured()) return NextResponse.json({ ok: false, error: 'not configured' }, { status: 400 });
  if (isCollecting()) return NextResponse.json({ ok: false, error: 'a collection is already in progress' }, { status: 409 });
  let dryRun = false;
  try {
    const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean };
    dryRun = body.dryRun === true;
  } catch {
    /* no body */
  }
  // run in background — collection takes minutes across chains
  runCollection({ dryRun }).catch((e) =>
    console.error('collect: background run failed:', e instanceof Error ? e.message : e),
  );
  return NextResponse.json({ ok: true, started: true, dryRun });
}

/** Update collection settings. Body: { enabledChains?, destination?, auto?, dustG?, mainWalletId? } */
export async function PATCH(req: Request) {
  if (!isDbConfigured()) return NextResponse.json({ ok: false, error: 'not configured' }, { status: 400 });
  try {
    const body = (await req.json()) as Record<string, string>;
    const fields: { field: string; key: string; validate: (v: string) => string | null }[] = [
      {
        field: 'enabledChains',
        key: 'collection_enabled_chains',
        validate: (v) => {
          const chains = v.split(',').map((s) => s.trim().toLowerCase()).filter((s) => ['celo', 'xdc', 'fuse'].includes(s));
          return chains.length > 0 ? chains.join(',') : null;
        },
      },
      {
        field: 'destination',
        key: 'collection_destination',
        validate: (v) => (/^0x[0-9a-fA-F]{40}$/.test(v.trim()) || v.trim() === '' ? v.trim() : null),
      },
      { field: 'auto', key: 'collection_auto', validate: (v) => (v === 'true' || v === 'false' ? v : null) },
      {
        field: 'dustG',
        key: 'collection_dust_g',
        validate: (v) => {
          const n = parseFloat(v);
          return Number.isFinite(n) && n >= 0 ? String(n) : null;
        },
      },
      { field: 'mainWalletId', key: 'collection_main_wallet_id', validate: (v) => (v.trim() ? v.trim() : null) },
    ];
    for (const { field, key, validate } of fields) {
      if (body[field] !== undefined) {
        const clean = validate(String(body[field]));
        if (clean === null) return NextResponse.json({ ok: false, error: `invalid ${field}` }, { status: 400 });
        await setSetting(key, clean);
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
