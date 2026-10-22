import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { listSites } from "@/lib/agent/sites";
import { submissionCounts } from "@/lib/agent/submissions";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sites = await listSites();
  const counts: Record<string, { total: number; unread: number }> =
    await submissionCounts(sites.map((s) => s.id)).catch(() => ({}));
  return NextResponse.json({
    sites: sites.map((s) => ({ ...s, submissions: counts[s.id] ?? { total: 0, unread: 0 } })),
  });
}
