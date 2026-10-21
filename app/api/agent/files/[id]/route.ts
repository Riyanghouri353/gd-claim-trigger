import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { getAgentFile, AGENT_BUCKET } from "@/lib/agent/files";
import { getServiceClient } from "@/lib/agent/supabase";

export const dynamic = "force-dynamic";

/** Download a file the agent generated */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const file = await getAgentFile(id);
  if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });
  // Images live in Supabase Storage — fetch the object and stream it back
  // inline (no attachment disposition) so chat can embed screenshots.
  if (file.storage_path) {
    const sb = getServiceClient();
    const dl = await sb.storage.from(AGENT_BUCKET).download(file.storage_path);
    if (dl.error || !dl.data) {
      return NextResponse.json({ error: "File content missing" }, { status: 404 });
    }
    return new Response(await dl.data.arrayBuffer(), {
      headers: { "Content-Type": file.mime, "Cache-Control": "private, max-age=3600" },
    });
  }
  // Legacy rows stored images as base64 text in the content column.
  if (file.mime.startsWith("image/")) {
    return new Response(Buffer.from(file.content, "base64"), {
      headers: { "Content-Type": file.mime, "Cache-Control": "private, max-age=3600" },
    });
  }
  return new Response(file.content, {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `attachment; filename="${file.name.replace(/"/g, "")}"`,
    },
  });
}
