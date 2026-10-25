import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { runLoadTest, saveLoadTest, listLoadTests, deleteLoadTest } from "@/lib/agent/loadtest";

export const dynamic = "force-dynamic";

async function authed() {
  try {
    await requireSession();
    return null;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

/** GET: load test history, newest first. */
export async function GET() {
  const err = await authed();
  if (err) return err;
  const tests = await listLoadTests(50);
  return NextResponse.json({ tests });
}

/**
 * POST: run a load test and store it.
 * { url, mode: 'burst'|'sustained', requests?, rps?, durationSec?,
 *   concurrency?, ownerConfirmed? }
 * The run waits for completion (up to ~60s + request timeouts); for longer
 * campaigns use a deep task instead.
 */
export async function POST(req: Request) {
  const err = await authed();
  if (err) return err;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.url?.trim()) {
    return NextResponse.json({ error: "A URL is required" }, { status: 400 });
  }
  try {
    const result = await runLoadTest({
      url: String(body.url).trim(),
      mode: body.mode === "sustained" ? "sustained" : "burst",
      requests: body.requests ? Number(body.requests) : undefined,
      rps: body.rps ? Number(body.rps) : undefined,
      durationSec: body.durationSec ? Number(body.durationSec) : undefined,
      concurrency: body.concurrency ? Number(body.concurrency) : undefined,
      ownerConfirmed: !!body.ownerConfirmed,
    });
    const saved = await saveLoadTest(result).catch(() => null);
    return NextResponse.json({ ok: true, result, id: saved?.id ?? null });
  } catch (e: any) {
    const msg = e?.message || "Load test failed";
    const status = msg.startsWith("NEEDS_CONFIRMATION") ? 403 : 400;
    return NextResponse.json({ error: msg, needsConfirmation: status === 403 }, { status });
  }
}

/** DELETE ?id= — removes one history row. */
export async function DELETE(req: Request) {
  const err = await authed();
  if (err) return err;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  await deleteLoadTest(id);
  return NextResponse.json({ ok: true });
}
