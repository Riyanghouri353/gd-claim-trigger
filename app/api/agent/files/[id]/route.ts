import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { getAgentFile } from "@/lib/agent/files";

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
  return new Response(file.content, {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `attachment; filename="${file.name.replace(/"/g, "")}"`,
    },
  });
}
