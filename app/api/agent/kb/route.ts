import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import {
  listDocuments,
  searchKnowledge,
  ingestDocument,
  deleteDocument,
  getKbStats,
} from "@/lib/agent/knowledge";
import { fetchPublicText } from "@/lib/agent/web";

export const dynamic = "force-dynamic";

async function authed() {
  try {
    await requireSession();
    return null;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

/** GET: list documents + stats, or ?q= for ranked search hits. */
export async function GET(req: Request) {
  const err = await authed();
  if (err) return err;
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (q) {
    const hits = await searchKnowledge(q, 10);
    return NextResponse.json({ hits });
  }
  const [documents, stats] = await Promise.all([listDocuments(100), getKbStats()]);
  return NextResponse.json({ documents, stats });
}

/**
 * POST: ingest a document.
 * { title?, content } → pasted text; { title?, url } → fetched page text.
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
  try {
    if (body.url) {
      const r = await fetchPublicText(String(body.url));
      if (!r.ok) return NextResponse.json({ error: `Could not read that URL (status ${r.status})` }, { status: 400 });
      const title = body.title?.trim() || new URL(String(body.url)).hostname;
      const { document, chunks } = await ingestDocument({
        title,
        content: r.text,
        source_type: "url",
        source_url: String(body.url),
      });
      return NextResponse.json({ ok: true, document, chunks, truncated: r.truncated });
    }
    if (!body.content?.trim()) {
      return NextResponse.json({ error: "Content or URL is required" }, { status: 400 });
    }
    const { document, chunks } = await ingestDocument({
      title: body.title?.trim() || "Untitled document",
      content: String(body.content),
      source_type: "text",
    });
    return NextResponse.json({ ok: true, document, chunks });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Could not save the document" }, { status: 400 });
  }
}

/** DELETE ?id= — removes the document and all its chunks. */
export async function DELETE(req: Request) {
  const err = await authed();
  if (err) return err;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  await deleteDocument(id);
  return NextResponse.json({ ok: true });
}
