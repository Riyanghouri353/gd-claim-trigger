import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { listSubmissions, markSubmissionRead, deleteSubmission } from "@/lib/agent/submissions";

export const dynamic = "force-dynamic";

async function authed() {
  try {
    await requireSession();
    return true;
  } catch {
    return false;
  }
}

/** Submissions inbox for one site (params.id = site id). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const limit = Number(url.searchParams.get("limit") || 50);
  const submissions = await listSubmissions(id, limit, unreadOnly);
  return NextResponse.json({ submissions });
}

export async function PATCH(req: Request) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await markSubmissionRead(String(body.id), body.read !== false);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sub = new URL(req.url).searchParams.get("sub");
  if (!sub) return NextResponse.json({ error: "sub required" }, { status: 400 });
  await deleteSubmission(sub);
  return NextResponse.json({ ok: true });
}
