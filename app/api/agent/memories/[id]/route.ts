import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { deleteMemory } from "@/lib/agent/memory";

export const dynamic = "force-dynamic";

/** Delete a memory */
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  await deleteMemory(id);
  return NextResponse.json({ ok: true });
}
