import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { listSites } from "@/lib/agent/sites";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sites = await listSites();
  return NextResponse.json({ sites });
}
