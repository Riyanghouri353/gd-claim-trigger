import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { deleteSiteCompletely } from "@/lib/agent/sites";

export const dynamic = "force-dynamic";

/** Delete a site: Vercel project + its veritask.site DNS records + DB rows. */
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const result = await deleteSiteCompletely(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
