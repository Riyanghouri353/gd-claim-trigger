import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { startSitePreview, stopSitePreview, getSitePreview } from "@/lib/agent/site-preview";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

async function authed() {
  try {
    await requireSession();
    return true;
  } catch {
    return false;
  }
}

/** Live E2B preview for one site (params.id = site id or slug). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const { resolveSite } = await import("@/lib/agent/sites");
  const site = await resolveSite(id).catch(() => null);
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
  return NextResponse.json({ preview: getSitePreview(site.id) });
}

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const result = await startSitePreview(id);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const { resolveSite } = await import("@/lib/agent/sites");
  const site = await resolveSite(id).catch(() => null);
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
  return NextResponse.json(await stopSitePreview(site.id));
}
