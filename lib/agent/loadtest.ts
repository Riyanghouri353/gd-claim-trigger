import { getServiceClient } from "./supabase";
import { assertPublicUrl } from "./connectors";

/**
 * Load testing: how much traffic can a site take before it degrades?
 *
 * SAFETY (enforced in code, not just in prompts):
 * - GET requests only — a test never changes data on the target.
 * - SSRF-guarded: private/loopback/link-local/reserved IPs are blocked.
 * - Ownership gate: Riyan's own domains and agent-built sites run freely;
 *   any other host requires explicit owner/permission confirmation.
 * - Hard caps: 60,000 requests, 1000 req/s, 60 seconds per test.
 */

export type LoadMode = "burst" | "sustained";

export interface LoadTestInput {
  url: string;
  mode?: LoadMode;
  /** Burst: total requests (default 1000). Sustained: derived from rps × duration. */
  requests?: number;
  /** Sustained: target requests per second (default 100). */
  rps?: number;
  /** Sustained: seconds to run (default 10). */
  durationSec?: number;
  /** Max requests in flight at once (default 200). */
  concurrency?: number;
  /** Caller confirms the user owns the target or has permission to test it. */
  ownerConfirmed?: boolean;
  /** Per-request timeout in ms (default 10,000). */
  timeoutMs?: number;
}

export interface LoadTestResult {
  url: string;
  mode: LoadMode;
  requested: number;
  rps: number | null;
  durationSec: number | null;
  concurrency: number;
  total: number;
  succeeded: number;
  failed: number;
  errorRate: number;
  statusCounts: Record<string, number>;
  errors: Record<string, number>;
  latencyMs: { min: number; mean: number; p50: number; p95: number; p99: number; max: number };
  durationMs: number;
  actualRps: number;
  verdict: "stable" | "strained" | "overloaded";
  verdictNote: string;
}

export interface LoadTestRow extends LoadTestResult {
  id: string;
  created_at: string;
}

const MAX_TOTAL = 60_000;
const MAX_RPS = 1000;
const MAX_DURATION_SEC = 60;
const MAX_CONCURRENCY = 500;
const OWN_SUFFIXES = [".veritask.site", ".ghouri.site"];
const OWN_HOSTS = new Set(["gd-claim-trigger.onrender.com", "gd-claim.ghouri.site"]);

function isOwnHost(host: string): boolean {
  const h = host.toLowerCase();
  if (OWN_HOSTS.has(h)) return true;
  return OWN_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s));
}

/** Ownership gate + SSRF guard. Throws with a plain message when blocked. */
export async function checkLoadTarget(rawUrl: string, ownerConfirmed?: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  await assertPublicUrl(url);
  if (isOwnHost(url.hostname)) return url;
  // Agent-built sites (live or preview URLs) count as his own.
  try {
    const { data } = await getServiceClient()
      .from("sites")
      .select("live_url,preview_url")
      .limit(200);
    for (const s of (data ?? []) as { live_url: string | null; preview_url: string | null }[]) {
      for (const u of [s.live_url, s.preview_url]) {
        if (!u) continue;
        try {
          if (new URL(u).hostname.toLowerCase() === url.hostname.toLowerCase()) return url;
        } catch {
          /* ignore malformed stored URL */
        }
      }
    }
  } catch {
    /* sites lookup failed — fall through to the confirmation gate */
  }
  if (!ownerConfirmed) {
    throw new Error(
      "NEEDS_CONFIRMATION: this is not one of your own sites. Confirm you own it or have permission to load-test it, then run the test again with that confirmation."
    );
  }
  return url;
}

function classifyError(e: any): string {
  const name = String(e?.name ?? "");
  const msg = String(e?.message ?? "").toLowerCase();
  if (name === "AbortError" || msg.includes("aborted") || msg.includes("timeout")) return "timeout";
  if (msg.includes("econnrefused") || msg.includes("connect")) return "connection refused";
  if (msg.includes("enotfound") || msg.includes("getaddrinfo")) return "DNS failure";
  if (msg.includes("econnreset") || msg.includes("socket hang up")) return "connection reset";
  return "request error";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function fireOne(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; ms: number; err?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "RiyanAgent-loadtest/1.0" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    // Drain the body so the connection can be reused, without keeping it.
    await res.arrayBuffer().catch(() => {});
    return { ok: res.status < 400, status: res.status, ms: Date.now() - start };
  } catch (e: any) {
    return { ok: false, status: 0, ms: Date.now() - start, err: classifyError(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runLoadTest(input: LoadTestInput): Promise<LoadTestResult> {
  const url = await checkLoadTarget(input.url, input.ownerConfirmed);
  const mode: LoadMode = input.mode ?? "burst";
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 10_000, 1000), 30_000);
  const concurrency = Math.min(Math.max(input.concurrency ?? 200, 1), MAX_CONCURRENCY);

  let total = 0;
  let rps: number | null = null;
  let durationSec: number | null = null;
  if (mode === "burst") {
    total = Math.min(Math.max(input.requests ?? 1000, 1), 10_000);
  } else {
    rps = Math.min(Math.max(input.rps ?? 100, 1), MAX_RPS);
    durationSec = Math.min(Math.max(input.durationSec ?? 10, 1), MAX_DURATION_SEC);
    total = Math.min(rps * durationSec, MAX_TOTAL);
  }

  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  const errors: Record<string, number> = {};
  let succeeded = 0;
  let failed = 0;

  const record = (r: { ok: boolean; status: number; ms: number; err?: string }) => {
    latencies.push(r.ms);
    const key = r.status ? `HTTP ${r.status}` : "no response";
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    if (r.ok) {
      succeeded += 1;
    } else {
      failed += 1;
      const kind = r.status >= 400 ? `HTTP ${r.status}` : (r.err ?? "request error");
      errors[kind] = (errors[kind] ?? 0) + 1;
    }
  };

  const startedAt = Date.now();
  if (mode === "burst") {
    // Wave pool: `concurrency` workers pulling from a shared counter.
    let next = 0;
    const worker = async () => {
      while (next < total) {
        const i = next;
        next += 1;
        if (i >= total) break;
        record(await fireOne(url.toString(), timeoutMs));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  } else {
    // Sustained: launch requests on a schedule (rps per second), bounded
    // by the concurrency cap; slow targets fall behind honestly.
    const intervalMs = 1000 / (rps as number);
    const inFlight = new Set<Promise<void>>();
    for (let i = 0; i < total; i++) {
      const targetAt = startedAt + i * intervalMs;
      const wait = targetAt - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (inFlight.size >= concurrency) await Promise.race(inFlight);
      const p = fireOne(url.toString(), timeoutMs).then((r) => {
        record(r);
        inFlight.delete(p);
      });
      inFlight.add(p);
    }
    await Promise.all(inFlight);
  }
  const durationMs = Date.now() - startedAt;

  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  const latencyMs = {
    min: sorted[0] ?? 0,
    mean: Math.round(mean),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
  const errorRate = total ? failed / total : 0;
  const actualRps = durationMs ? Math.round((total / durationMs) * 1000 * 10) / 10 : 0;

  let verdict: LoadTestResult["verdict"];
  let verdictNote: string;
  if (failed === total || errorRate >= 0.1 || latencyMs.p95 >= 10_000) {
    verdict = "overloaded";
    verdictNote = "The site could not handle this load: too many requests failed or responses were extremely slow.";
  } else if (errorRate >= 0.01 || latencyMs.p95 >= 2000) {
    verdict = "strained";
    verdictNote = "The site survived, but it struggled: some requests failed or responses slowed down noticeably.";
  } else {
    verdict = "stable";
    verdictNote = "The site handled the load well: almost every request succeeded quickly.";
  }

  return {
    url: url.toString(),
    mode,
    requested: total,
    rps,
    durationSec,
    concurrency,
    total,
    succeeded,
    failed,
    errorRate: Math.round(errorRate * 1000) / 10,
    statusCounts,
    errors,
    latencyMs,
    durationMs,
    actualRps,
    verdict,
    verdictNote,
  };
}

export async function saveLoadTest(result: LoadTestResult): Promise<LoadTestRow> {
  const { data, error } = await getServiceClient()
    .from("load_tests")
    .insert({
      url: result.url,
      mode: result.mode,
      requested: result.requested,
      rps: result.rps,
      duration_sec: result.durationSec,
      concurrency: result.concurrency,
      total: result.total,
      succeeded: result.succeeded,
      failed: result.failed,
      error_rate: result.errorRate,
      status_counts: result.statusCounts,
      errors: result.errors,
      latency_ms: result.latencyMs,
      actual_rps: result.actualRps,
      verdict: result.verdict,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not save the load test.");
  return data as unknown as LoadTestRow;
}

export async function listLoadTests(limit = 50): Promise<LoadTestRow[]> {
  const { data } = await getServiceClient()
    .from("load_tests")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as unknown as LoadTestRow[];
}

export async function deleteLoadTest(id: string): Promise<void> {
  await getServiceClient().from("load_tests").delete().eq("id", id);
}
