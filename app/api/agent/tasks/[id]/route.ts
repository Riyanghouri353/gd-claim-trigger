import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { getTask, updateTask, deleteTask, listTaskRuns, type TaskInput } from "@/lib/agent/tasks";

export const dynamic = "force-dynamic";

async function authed() {
  try {
    await requireSession();
    return true;
  } catch {
    return false;
  }
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  const runs = await listTaskRuns(id, 10);
  return NextResponse.json({ task, runs });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Partial<TaskInput>;
  try {
    const task = await updateTask(id, body);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json({ task });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Could not update task" }, { status: 400 });
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  await deleteTask(id);
  return NextResponse.json({ ok: true });
}
