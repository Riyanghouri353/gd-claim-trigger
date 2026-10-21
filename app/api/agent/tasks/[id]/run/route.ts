import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { runTaskNow } from "@/lib/agent/task-runner";

export const dynamic = "force-dynamic";

/** Run the task immediately (in the background); watch its conversation or run history. */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const result = await runTaskNow(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, started: true });
}
