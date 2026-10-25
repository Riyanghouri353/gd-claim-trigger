"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Gauge, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ThemeToggle from "../theme-toggle";

interface LoadTest {
  id: string;
  url: string;
  mode: string;
  requested: number;
  rps: number | null;
  duration_sec: number | null;
  concurrency: number;
  total: number;
  succeeded: number;
  failed: number;
  error_rate: number;
  status_counts: Record<string, number>;
  errors: Record<string, number>;
  latency_ms: { min: number; mean: number; p50: number; p95: number; p99: number; max: number };
  actual_rps: number;
  verdict: string;
  created_at: string;
}

function VerdictBadge({ v }: { v: string }) {
  return (
    <Badge variant={v === "stable" ? "success" : v === "strained" ? "secondary" : "destructive"}>
      {v}
    </Badge>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-muted/40 px-3 py-2.5">
      <p className="text-lg font-bold leading-tight">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export default function LoadTestsClient() {
  const router = useRouter();
  const [tests, setTests] = useState<LoadTest[]>([]);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"burst" | "sustained">("burst");
  const [requests, setRequests] = useState(1000);
  const [rps, setRps] = useState(100);
  const [durationSec, setDurationSec] = useState(10);
  const [concurrency, setConcurrency] = useState(200);
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState("");
  const [result, setResult] = useState<LoadTest | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/agent/load-tests");
    if (res.status === 401) {
      router.push("/agent/login");
      return;
    }
    if (res.ok) setTests((await res.json()).tests ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setRunning(true);
    setMsg("");
    setResult(null);
    setNeedsConfirm(false);
    const res = await fetch("/api/agent/load-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url.trim(),
        mode,
        requests,
        rps,
        durationSec,
        concurrency,
        ownerConfirmed,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      const r = j.result;
      setResult({
        id: j.id ?? "latest",
        url: r.url,
        mode: r.mode,
        requested: r.requested,
        rps: r.rps,
        duration_sec: r.durationSec,
        concurrency: r.concurrency,
        total: r.total,
        succeeded: r.succeeded,
        failed: r.failed,
        error_rate: r.errorRate,
        status_counts: r.statusCounts,
        errors: r.errors,
        latency_ms: r.latencyMs,
        actual_rps: r.actualRps,
        verdict: r.verdict,
        created_at: new Date().toISOString(),
      });
      setMsg(r.verdictNote);
      load();
    } else {
      if (j.needsConfirmation) {
        setNeedsConfirm(true);
        setMsg("This is not one of your own sites — tick the confirmation below that you own it or have permission to test it, then run again.");
      } else {
        setMsg(j.error || "Load test failed.");
      }
    }
    setRunning(false);
  }

  async function remove(id: string) {
    await fetch(`/api/agent/load-tests?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setConfirmId(null);
    load();
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Load tests</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Can your site survive heavy traffic? Fire controlled load at it and see what breaks — before real users do.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle />
          <Button variant="ghost" onClick={() => router.push("/agent")}>
            <ArrowLeft />
            Back to chat
          </Button>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Gauge className="size-4" />
            </span>
            Run a load test
          </CardTitle>
          <CardDescription>
            GET requests only — a test never changes data on the target. Only test sites you own or have
            permission to test. Limits: 10,000 requests per burst, 1000 req/s, 60 seconds per test.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {msg && <p className="rounded-xl bg-muted/50 px-3.5 py-2.5 text-sm">{msg}</p>}
          <form onSubmit={run} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="lt-url">Site URL</Label>
              <Input
                id="lt-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-site.veritask.site/"
                required
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={mode === "burst" ? "default" : "outline"}
                size="sm"
                onClick={() => setMode("burst")}
              >
                Burst — N requests, as fast as possible
              </Button>
              <Button
                type="button"
                variant={mode === "sustained" ? "default" : "outline"}
                size="sm"
                onClick={() => setMode("sustained")}
              >
                Sustained — R req/s for S seconds
              </Button>
            </div>
            {mode === "burst" ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Total requests (max 10,000)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10000}
                    value={requests}
                    onChange={(e) => setRequests(parseInt(e.target.value || "1000", 10))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Concurrency (max 500)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    value={concurrency}
                    onChange={(e) => setConcurrency(parseInt(e.target.value || "200", 10))}
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label>Req / second (max 1000)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    value={rps}
                    onChange={(e) => setRps(parseInt(e.target.value || "100", 10))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Duration, seconds (max 60)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={60}
                    value={durationSec}
                    onChange={(e) => setDurationSec(parseInt(e.target.value || "10", 10))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Concurrency (max 500)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    value={concurrency}
                    onChange={(e) => setConcurrency(parseInt(e.target.value || "200", 10))}
                  />
                </div>
              </div>
            )}
            {needsConfirm && (
              <label className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={ownerConfirmed}
                  onChange={(e) => setOwnerConfirmed(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I own this site, or I have explicit permission from its owner to load-test it. I understand
                  that hammering a site without permission can take it down for real users.
                </span>
              </label>
            )}
            <Button type="submit" disabled={running || !url.trim()}>
              {running && <Loader2 className="animate-spin" />}
              {running ? "Testing… (this takes as long as the test)" : "Run load test"}
            </Button>
          </form>

          {result && (
            <div className="space-y-3 border-t pt-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                Result for <span className="truncate">{result.url}</span>
                <VerdictBadge v={result.verdict} />
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Requests" value={`${result.total}`} />
                <Stat label="Succeeded" value={`${result.succeeded}`} />
                <Stat label="Failed" value={`${result.failed} (${result.error_rate}%)`} />
                <Stat label="Actual speed" value={`${result.actual_rps} req/s`} />
                <Stat label="Median (p50)" value={`${result.latency_ms.p50} ms`} />
                <Stat label="Slow tail (p95)" value={`${result.latency_ms.p95} ms`} />
                <Stat label="Worst (p99)" value={`${result.latency_ms.p99} ms`} />
                <Stat label="Slowest" value={`${result.latency_ms.max} ms`} />
              </div>
              <p className="text-xs text-muted-foreground">
                Status codes: {Object.entries(result.status_counts).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—"}
                {Object.keys(result.errors).length > 0 &&
                  ` | Errors: ${Object.entries(result.errors).map(([k, v]) => `${k}: ${v}`).join(" · ")}`}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
          <CardDescription>Past tests, newest first.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!loading && tests.length === 0 && (
            <p className="text-sm text-muted-foreground">No load tests yet.</p>
          )}
          {tests.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 rounded-xl border bg-muted/40 px-4 py-2.5">
              <div className="min-w-0">
                <p className="flex items-center gap-2 truncate text-sm font-medium">
                  <span className="truncate">{t.url}</span>
                  <VerdictBadge v={t.verdict} />
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {t.mode === "burst"
                    ? `${t.requested} requests`
                    : `${t.rps} req/s × ${t.duration_sec}s`} · {t.succeeded}/{t.total} ok · p95 {t.latency_ms.p95} ms ·{" "}
                  {t.actual_rps} req/s · {new Date(t.created_at).toLocaleString()}
                </p>
              </div>
              {confirmId === t.id ? (
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="destructive" onClick={() => remove(t.id)}>
                    Confirm
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmId(null)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() => setConfirmId(t.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
