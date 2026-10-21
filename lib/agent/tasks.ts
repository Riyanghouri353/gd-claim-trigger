import { getServiceClient, type Database } from "./supabase";

type AgentTaskUpdate = Database["public"]["Tables"]["agent_tasks"]["Update"];

/**
 * Scheduled autonomous tasks: the user defines a job (instructions + a
 * schedule) once; the cron tick executes it headlessly with the agent's
 * tools and delivers the report into a dedicated conversation per task.
 */

export type ScheduleKind = "daily" | "weekly" | "interval";

export interface AgentTask {
  id: string;
  name: string;
  instructions: string;
  schedule_kind: ScheduleKind;
  time_of_day: string | null;
  weekday: number | null;
  interval_minutes: number | null;
  timezone: string;
  enabled: boolean;
  conversation_id: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskInput {
  name: string;
  instructions: string;
  schedule_kind: ScheduleKind;
  time_of_day?: string | null;
  weekday?: number | null;
  interval_minutes?: number | null;
  timezone?: string;
  enabled?: boolean;
}

// --- timezone helpers -------------------------------------------------------

function partsInTz(tz: string, date: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") p[part.type] = parseInt(part.value, 10);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute };
}

/** Convert a wall-clock time in `tz` to the matching UTC instant. */
function zonedTimeToUtc(tz: string, y: number, mo: number, d: number, hh: number, mm: number): Date {
  let guess = Date.UTC(y, mo - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const p = partsInTz(tz, new Date(guess));
    const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = Date.UTC(y, mo - 1, d, hh, mm) - wallAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

function parseTimeOfDay(t: string | null | undefined): { hh: number; mm: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t || "09:00").trim());
  if (!m) return { hh: 9, mm: 0 };
  return { hh: Math.min(23, parseInt(m[1], 10)), mm: Math.min(59, parseInt(m[2], 10)) };
}

/** The next run instant for a task, strictly after `from`. */
export function computeNextRun(task: TaskInput & { timezone: string }, from = new Date()): Date {
  const tz = task.timezone || "Asia/Karachi";
  if (task.schedule_kind === "interval") {
    const mins = Math.max(15, task.interval_minutes || 60);
    return new Date(from.getTime() + mins * 60_000);
  }
  const { hh, mm } = parseTimeOfDay(task.time_of_day);
  const now = partsInTz(tz, from);
  const base = new Date(Date.UTC(now.year, now.month - 1, now.day));

  if (task.schedule_kind === "weekly") {
    const target = ((task.weekday ?? 1) % 7 + 7) % 7;
    const todayDow = base.getUTCDay();
    let add = (target - todayDow + 7) % 7;
    let candidate = zonedTimeToUtc(
      tz,
      base.getUTCFullYear(),
      base.getUTCMonth() + 1,
      base.getUTCDate() + add,
      hh,
      mm
    );
    if (candidate <= from) {
      add += 7;
      candidate = zonedTimeToUtc(
        tz,
        base.getUTCFullYear(),
        base.getUTCMonth() + 1,
        base.getUTCDate() + add,
        hh,
        mm
      );
    }
    return candidate;
  }

  // daily
  let candidate = zonedTimeToUtc(tz, now.year, now.month, now.day, hh, mm);
  if (candidate <= from) {
    const tomorrow = new Date(Date.UTC(now.year, now.month - 1, now.day + 1));
    candidate = zonedTimeToUtc(
      tz,
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      hh,
      mm
    );
  }
  return candidate;
}

export function describeSchedule(task: {
  schedule_kind: string;
  time_of_day: string | null;
  weekday: number | null;
  interval_minutes: number | null;
  timezone: string;
}): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (task.schedule_kind === "interval") return `every ${task.interval_minutes ?? 60} min`;
  if (task.schedule_kind === "weekly") {
    return `every ${days[((task.weekday ?? 1) % 7 + 7) % 7]} at ${task.time_of_day} (${task.timezone})`;
  }
  return `daily at ${task.time_of_day} (${task.timezone})`;
}

// --- CRUD -------------------------------------------------------------------

export function validateTaskInput(input: TaskInput): string | null {
  if (!input.name?.trim()) return "Task name is required";
  if (!input.instructions?.trim()) return "Task instructions are required";
  if (!["daily", "weekly", "interval"].includes(input.schedule_kind)) return "Invalid schedule kind";
  if (input.schedule_kind === "interval") {
    const m = input.interval_minutes ?? 0;
    if (!m || m < 15) return "Interval must be at least 15 minutes";
    if (m > 60 * 24 * 7) return "Interval is too large";
  }
  if (input.schedule_kind !== "interval" && !/^\d{1,2}:\d{2}$/.test(input.time_of_day || "")) {
    return "Time of day must be HH:MM (24h)";
  }
  return null;
}

export async function createTask(input: TaskInput): Promise<AgentTask> {
  const err = validateTaskInput(input);
  if (err) throw new Error(err);
  const tz = input.timezone || "Asia/Karachi";
  const next = computeNextRun({ ...input, timezone: tz });
  const { data, error } = await getServiceClient()
    .from("agent_tasks")
    .insert({
      name: input.name.trim().slice(0, 100),
      instructions: input.instructions.trim().slice(0, 8000),
      schedule_kind: input.schedule_kind,
      time_of_day: input.schedule_kind === "interval" ? null : input.time_of_day,
      weekday: input.schedule_kind === "weekly" ? input.weekday ?? 1 : null,
      interval_minutes: input.schedule_kind === "interval" ? input.interval_minutes : null,
      timezone: tz,
      enabled: input.enabled ?? true,
      next_run_at: next.toISOString(),
    })
    .select("*")
    .single();
  if (error || !data) throw new Error("Could not create task");
  return data as AgentTask;
}

export async function listTasks(): Promise<AgentTask[]> {
  const { data } = await getServiceClient()
    .from("agent_tasks")
    .select("*")
    .order("created_at", { ascending: false });
  return (data as AgentTask[]) ?? [];
}

export async function getTask(id: string): Promise<AgentTask | null> {
  const { data } = await getServiceClient()
    .from("agent_tasks")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return (data as AgentTask) ?? null;
}

export async function updateTask(
  id: string,
  patch: Partial<TaskInput> & { conversation_id?: string | null }
): Promise<AgentTask | null> {
  const current = await getTask(id);
  if (!current) return null;
  const merged: TaskInput = {
    name: patch.name ?? current.name,
    instructions: patch.instructions ?? current.instructions,
    schedule_kind: (patch.schedule_kind as ScheduleKind) ?? current.schedule_kind,
    time_of_day: patch.time_of_day !== undefined ? patch.time_of_day : current.time_of_day,
    weekday: patch.weekday !== undefined ? patch.weekday : current.weekday,
    interval_minutes:
      patch.interval_minutes !== undefined ? patch.interval_minutes : current.interval_minutes,
    timezone: patch.timezone ?? current.timezone,
    enabled: patch.enabled ?? current.enabled,
  };
  const err = validateTaskInput(merged);
  if (err) throw new Error(err);
  const scheduleChanged =
    merged.schedule_kind !== current.schedule_kind ||
    merged.time_of_day !== current.time_of_day ||
    merged.weekday !== current.weekday ||
    merged.interval_minutes !== current.interval_minutes ||
    merged.timezone !== current.timezone ||
    (merged.enabled && !current.enabled);
  const update: AgentTaskUpdate = {
    name: merged.name,
    instructions: merged.instructions,
    schedule_kind: merged.schedule_kind,
    timezone: merged.timezone,
    enabled: merged.enabled,
    time_of_day: merged.schedule_kind === "interval" ? null : merged.time_of_day,
    weekday: merged.schedule_kind === "weekly" ? merged.weekday ?? 1 : null,
    interval_minutes: merged.schedule_kind === "interval" ? merged.interval_minutes : null,
    updated_at: new Date().toISOString(),
  };
  if (patch.conversation_id !== undefined) update.conversation_id = patch.conversation_id;
  if (scheduleChanged && merged.enabled) {
    update.next_run_at = computeNextRun({ ...merged, timezone: merged.timezone! }).toISOString();
  }
  const { data, error } = await getServiceClient()
    .from("agent_tasks")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error("Could not update task");
  return data as AgentTask;
}

export async function deleteTask(id: string): Promise<void> {
  await getServiceClient().from("agent_tasks").delete().eq("id", id);
}

export interface TaskRun {
  id: string;
  task_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  result_excerpt: string | null;
  error: string | null;
}

export async function listTaskRuns(taskId: string, limit = 10): Promise<TaskRun[]> {
  const { data } = await getServiceClient()
    .from("agent_task_runs")
    .select("*")
    .eq("task_id", taskId)
    .order("started_at", { ascending: false })
    .limit(limit);
  return (data as TaskRun[]) ?? [];
}
