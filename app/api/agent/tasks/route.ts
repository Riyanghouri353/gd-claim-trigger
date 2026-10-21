import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { createTask, listTasks, type TaskInput } from "@/lib/agent/tasks";
import { runDueTasks } from "@/lib/agent/task-runner";

export const dynamic = "force-dynamic";

async function authed() {
  try {
    await requireSession();
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ tasks: await listTasks() });
}

export async function POST(req: Request) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Partial<TaskInput>;
  try {
    const task = await createTask({
      name: body.name || "",
      instructions: body.instructions || "",
      schedule_kind: (body.schedule_kind as TaskInput["schedule_kind"]) || "daily",
      time_of_day: body.time_of_day ?? "09:00",
      weekday: body.weekday ?? 1,
      interval_minutes: body.interval_minutes ?? 60,
      timezone: body.timezone || "Asia/Karachi",
      enabled: body.enabled ?? true,
    });
    return NextResponse.json({ task });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Could not create task" }, { status: 400 });
  }
}

/** Opportunistic tick from the UI (session-gated twin of the cron route). */
export async function PUT() {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { started } = await runDueTasks(3);
  return NextResponse.json({ ok: true, started });
}
