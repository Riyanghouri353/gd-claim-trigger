import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { listMemories, addMemory } from "@/lib/agent/memory";

export const dynamic = "force-dynamic";

/** List saved memories */
export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const memories = await listMemories(200);
  return NextResponse.json({ memories });
}

/** Add a memory manually */
export async function POST(req: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { content } = await req.json();
  if (!content?.trim()) {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }
  const stored = await addMemory(content);
  return NextResponse.json({ ok: true, stored });
}
