import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import {
  listDeepTasks,
  createDeepTask,
  deleteDeepTask,
  runDeepTask,
} from "@/lib/agent/deep-tasks";

export const dynamic = "force-dynamic";

async function authed() {
  try {
    await requireSession();
    return null;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

/** GET: recent deep tasks, newest first. */
export async function GET() {
  const err = await authed();
  if (err) return err;
  const tasks = await listDeepTasks(50);
  return NextResponse.json({ tasks });
}

/**
 * POST: start a deep task from the Tasks page ({ goal }).
 * Runs detached — the report lands in the task's conversation.
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
  if (!body.goal?.trim()) {
    return NextResponse.json({ error: "A goal is required" }, { status: 400 });
  }
  try {
    const task = await createDeepTask(null, String(body.goal));
    void runDeepTask(task.id);
    return NextResponse.json({ ok: true, task });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Could not start the deep task" }, { status: 400 });
  }
}

/** DELETE ?id= — removes a deep task row (running tasks finish regardless). */
export async function DELETE(req: Request) {
  const err = await authed();
  if (err) return err;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  await deleteDeepTask(id);
  return NextResponse.json({ ok: true });
}
