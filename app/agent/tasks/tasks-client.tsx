"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlarmClock, ArrowLeft, Loader2, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import ThemeToggle from "../theme-toggle";

interface Task {
  id: string;
  name: string;
  instructions: string;
  schedule_kind: string;
  time_of_day: string | null;
  weekday: number | null;
  interval_minutes: number | null;
  timezone: string;
  enabled: boolean;
  conversation_id: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
}

interface Run {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  result_excerpt: string | null;
  error: string | null;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";

function describe(t: Task): string {
  if (t.schedule_kind === "interval") return `Every ${t.interval_minutes ?? 60} minutes`;
  if (t.schedule_kind === "weekly") return `Every ${DAYS[t.weekday ?? 1]} at ${t.time_of_day} (${t.timezone})`;
  return `Daily at ${t.time_of_day} (${t.timezone})`;
}

function fmt(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export default function TasksClient() {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [kind, setKind] = useState("daily");
  const [timeOfDay, setTimeOfDay] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [timezone, setTimezone] = useState("Asia/Karachi");
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/agent/tasks");
    if (res.status === 401) {
      router.push("/agent/login");
      return;
    }
    if (res.ok) setTasks((await res.json()).tasks ?? []);
    setLoading(false);
  }

  useEffect(() => {
    // Opportunistic tick: run anything due when the page opens, then list.
    fetch("/api/agent/tasks", { method: "PUT" }).catch(() => {});
    load();
    const iv = setInterval(load, 20000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setMsg("");
    const res = await fetch("/api/agent/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        instructions,
        schedule_kind: kind,
        time_of_day: timeOfDay,
        weekday,
        interval_minutes: intervalMinutes,
        timezone,
      }),
    });
    const j = await res.json().catch(() => ({}));
    setCreating(false);
    if (!res.ok) {
      setMsg("❌ " + (j.error || "Could not create task"));
      return;
    }
    setName("");
    setInstructions("");
    setMsg("✅ Task created — its reports will land in a chat named ⏰ " + (j.task?.name || ""));
    load();
  }

  async function toggle(t: Task, enabled: boolean) {
    await fetch(`/api/agent/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    load();
  }

  async function runNow(t: Task) {
    setRunningId(t.id);
    await fetch(`/api/agent/tasks/${t.id}/run`, { method: "POST" });
    setTimeout(() => {
      setRunningId(null);
      load();
    }, 1500);
    load();
  }

  async function remove(id: string) {
    await fetch(`/api/agent/tasks/${id}`, { method: "DELETE" });
    setConfirmId(null);
    load();
  }

  async function toggleRuns(t: Task) {
    if (runsFor === t.id) {
      setRunsFor(null);
      return;
    }
    const res = await fetch(`/api/agent/tasks/${t.id}`);
    if (res.ok) {
      setRuns((await res.json()).runs ?? []);
      setRunsFor(t.id);
    }
  }

  return (
    <div className="relative mx-auto w-full max-w-3xl px-4 py-8">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <button
        onClick={() => router.push("/agent")}
        className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to chat
      </button>

      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <AlarmClock className="size-6 text-primary" /> Scheduled tasks
      </h1>
      <p className="mb-8 mt-1 text-sm text-muted-foreground">
        Jobs your agent runs on its own — research, checks, digests, deploys. Each task
        reports into its own ⏰ chat in the sidebar. You can also create tasks by asking in
        chat: “Every morning at 9, check BTC and ETH prices and summarize the market.”
      </p>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="text-base">New task</CardTitle>
          <CardDescription>
            Instructions must be self-contained — the run won't see any chat history.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {msg && <p className="mb-3 text-sm">{msg}</p>}
          <form onSubmit={create} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="t-name">Name</Label>
              <Input
                id="t-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Morning crypto briefing"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-inst">Instructions</Label>
              <Textarea
                id="t-inst"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Check the current BTC and ETH prices, look at the top crypto headlines, and write a short briefing with what moved and why."
                rows={4}
                required
              />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label>Schedule</Label>
                <select value={kind} onChange={(e) => setKind(e.target.value)} className={selectClass}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="interval">Every X minutes</option>
                </select>
              </div>
              {kind !== "interval" && (
                <div className="space-y-1.5">
                  <Label>Time</Label>
                  <Input
                    type="time"
                    value={timeOfDay}
                    onChange={(e) => setTimeOfDay(e.target.value)}
                    className="w-32"
                  />
                </div>
              )}
              {kind === "weekly" && (
                <div className="space-y-1.5">
                  <Label>Day</Label>
                  <select
                    value={weekday}
                    onChange={(e) => setWeekday(parseInt(e.target.value, 10))}
                    className={selectClass}
                  >
                    {DAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {kind === "interval" && (
                <div className="space-y-1.5">
                  <Label>Minutes (min 15)</Label>
                  <Input
                    type="number"
                    min={15}
                    value={intervalMinutes}
                    onChange={(e) => setIntervalMinutes(parseInt(e.target.value || "60", 10))}
                    className="w-28"
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Timezone</Label>
                <Input
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-40"
                />
              </div>
              <Button type="submit" disabled={creating || !name.trim() || !instructions.trim()}>
                {creating && <Loader2 className="animate-spin" />}
                Create task
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : tasks.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No scheduled tasks yet — create one above, or ask in chat.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {tasks.map((t) => (
            <Card key={t.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  ⏰ {t.name}
                  {t.last_status && (
                    <Badge variant={t.last_status === "ok" ? "success" : "destructive"}>
                      last: {t.last_status}
                    </Badge>
                  )}
                  <span className="ml-auto flex items-center gap-2 text-xs font-normal text-muted-foreground">
                    {t.enabled ? "On" : "Off"}
                    <Switch checked={t.enabled} onCheckedChange={(v) => toggle(t, v)} />
                  </span>
                </CardTitle>
                <CardDescription>{describe(t)}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="line-clamp-2 text-sm text-muted-foreground">{t.instructions}</p>
                <p className="text-xs text-muted-foreground">
                  Last run: {fmt(t.last_run_at)} · Next run: {fmt(t.next_run_at)}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => runNow(t)} disabled={runningId === t.id}>
                    {runningId === t.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Play className="size-4" />
                    )}
                    Run now
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => toggleRuns(t)}>
                    {runsFor === t.id ? "Hide history" : "History"}
                  </Button>
                  <span className="flex-1" />
                  {confirmId === t.id ? (
                    <>
                      <Button size="sm" variant="destructive" onClick={() => remove(t.id)}>
                        Confirm delete
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmId(t.id)}
                    >
                      <Trash2 className="size-4" /> Delete
                    </Button>
                  )}
                </div>
                {runsFor === t.id && (
                  <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                    {runs.length === 0 && (
                      <p className="text-xs text-muted-foreground">No runs yet.</p>
                    )}
                    {runs.map((r) => (
                      <div key={r.id} className="text-xs">
                        <span className="font-medium">
                          {new Date(r.started_at).toLocaleString()} — {r.status}
                        </span>
                        {(r.result_excerpt || r.error) && (
                          <p className="mt-0.5 line-clamp-3 text-muted-foreground">
                            {r.error || r.result_excerpt}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
