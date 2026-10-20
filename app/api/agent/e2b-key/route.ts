import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { getE2BKey, setE2BKey, deleteE2BKey, testE2BKey } from "@/lib/agent/e2b";

export const dynamic = "force-dynamic";

/** Status: is an E2B key configured? (never returns the key) */
export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ configured: (await getE2BKey()) !== null });
}

/** Save an E2B key (tested first, stored AES-256 encrypted) */
export async function POST(req: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { key } = await req.json();
  if (!key?.trim()) {
    return NextResponse.json({ error: "Key is required" }, { status: 400 });
  }
  const check = await testE2BKey(key.trim());
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }
  await setE2BKey(key.trim());
  return NextResponse.json({ ok: true });
}

/** Remove the E2B key */
export async function DELETE() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await deleteE2BKey();
  return NextResponse.json({ ok: true });
}
