"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlarmClock, ArrowLeft, Brain, Loader2, Play, Trash2 } from "lucide-react";
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

interface DeepTask {
  id: string;
  conversation_id: string | null;
  goal: string;
  status: string;
  plan: { title: string; detail: string }[];
  progress: { at: string; note: string }[];
  result: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
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
  const [deepTasks, setDeepTasks] = useState<DeepTask[]>([]);
  const [deepGoal, setDeepGoal] = useState("");
  const [deepBusy, setDeepBusy] = useState(false);
  const [deepMsg, setDeepMsg] = useState("");
  const [deepConfirmId, setDeepConfirmId] = useState<string | null>(null);
  const [deepOpenId, setDeepOpenId] = useState<string | null>(null);

  async function loadDeep() {
    const res = await fetch("/api/agent/deep-tasks");
    if (res.ok) setDeepTasks((await res.json()).tasks ?? []);
  }

  async function load() {
    const res = await fetch("/api/agent/tasks");
    if (res.status === 401) {
      router.push("/agent/login");
      return;
    }
    if (res.ok) setTasks((await res.json()).tasks ?? []);
    setLoading(false);
    loadDeep();
  }

  async function createDeep(e: React.FormEvent) {
    e.preventDefault();
    if (!deepGoal.trim()) return;
    setDeepBusy(true);
    setDeepMsg("");
    const res = await fetch("/api/agent/deep-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: deepGoal.trim() }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      setDeepMsg("Deep task started — its report will land in a new chat in the sidebar when done.");
      setDeepGoal("");
      loadDeep();
    } else {
      setDeepMsg(j.error || "Could not start the deep task.");
    }
    setDeepBusy(false);
  }

  async function deleteDeep(id: string) {
    await fetch(`/api/agent/deep-tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setDeepConfirmId(null);
    loadDeep();
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

      {/* Deep tasks — long background jobs started from chat or here */}
      <Card className="mb-8 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Brain className="size-4" />
            </span>
            Deep tasks
          </CardTitle>
          <CardDescription>
            Long, multi-step jobs that run in the background (up to 20 minutes, 40 steps) and report back into
            chat. Ask in chat for one, or start one here — it keeps working even if you leave.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {deepMsg && <p className="rounded-xl bg-muted/50 px-3.5 py-2.5 text-sm">{deepMsg}</p>}
          <form onSubmit={createDeep} className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={deepGoal}
              onChange={(e) => setDeepGoal(e.target.value)}
              placeholder="e.g. Research the top 5 AI coding tools and compare pricing"
              className="flex-1"
            />
            <Button type="submit" disabled={deepBusy || !deepGoal.trim()} className="shrink-0">
              {deepBusy && <Loader2 className="animate-spin" />}
              Start deep task
            </Button>
          </form>
          {deepTasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No deep tasks yet — start one above, or ask in chat for a long job.
            </p>
          ) : (
            <div className="space-y-2">
              {deepTasks.map((d) => (
                <div key={d.id} className="rounded-xl border bg-muted/40 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">{d.goal}</p>
                    <div className="flex shrink-0 items-center gap-2">
                      {d.status === "running" && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                      <Badge
                        variant={
                          d.status === "done" ? "success" : d.status === "failed" ? "destructive" : "secondary"
                        }
                      >
                        {d.status}
                      </Badge>
                      <Button variant="ghost" size="sm" onClick={() => router.push("/agent")}>
                        Open chat
                      </Button>
                      {deepConfirmId === d.id ? (
                        <>
                          <Button size="sm" variant="destructive" onClick={() => deleteDeep(d.id)}>
                            Confirm
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setDeepConfirmId(null)}>
                            Keep
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeepConfirmId(d.id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => setDeepOpenId(deepOpenId === d.id ? null : d.id)}
                  >
                    {deepOpenId === d.id ? "Hide plan & progress" : "Show plan & progress"}
                  </button>
                  {deepOpenId === d.id && (
                    <div className="mt-2 space-y-2 text-sm">
                      {d.plan.length > 0 && (
                        <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                          {d.plan.map((s, i) => (
                            <li key={i}>
                              <span className="text-foreground">{s.title}</span>
                              {s.detail ? ` — ${s.detail}` : ""}
                            </li>
                          ))}
                        </ol>
                      )}
                      {d.progress.length > 0 && (
                        <ul className="space-y-0.5 text-xs text-muted-foreground">
                          {d.progress.slice(-8).map((p, i) => (
                            <li key={i}>
                              {new Date(p.at).toLocaleTimeString()} — {p.note}
                            </li>
                          ))}
                        </ul>
                      )}
                      {d.status === "failed" && d.error && (
                        <p className="text-destructive">{d.error}</p>
                      )}
                      {d.status === "done" && d.result && (
                        <p className="whitespace-pre-wrap text-muted-foreground">{d.result.slice(0, 600)}</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
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
