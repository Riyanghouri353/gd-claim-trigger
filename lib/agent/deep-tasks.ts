import { generateText } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { getServiceClient } from "./supabase";
import { runGeneration, lovableFetch } from "./task-runner";
import {
  listCandidateKeys,
  decryptRowKey,
  getSetting,
  type KeyProvider,
} from "./keys";
import type { AgentTask } from "./tasks";

export interface DeepTaskRow {
  id: string;
  conversation_id: string | null;
  goal: string;
  status: "queued" | "running" | "done" | "failed";
  plan: { title: string; detail: string }[];
  progress: { at: string; note: string }[];
  result: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
}

const MAX_CONCURRENT = 2;
const STALE_AFTER_MS = 25 * 60_000;
const MAX_ATTEMPTS = 3;

const runningDeep = new Set<string>();

function toRow(data: any): DeepTaskRow {
  return {
    ...data,
    plan: Array.isArray(data.plan) ? data.plan : [],
    progress: Array.isArray(data.progress) ? data.progress : [],
  };
}

export async function createDeepTask(
  conversationId: string | null,
  goal: string
): Promise<DeepTaskRow> {
  const sb = getServiceClient();
  let convoId = conversationId;
  if (!convoId) {
    // Every deep task needs a home for its report — give it its own chat.
    const { data } = await sb
      .from("conversations")
      .insert({ title: `Deep task: ${goal}`.slice(0, 80) })
      .select("id")
      .single();
    convoId = (data as { id: string } | null)?.id ?? null;
  }
  const { data, error } = await sb
    .from("deep_tasks")
    .insert({ conversation_id: convoId, goal: goal.trim().slice(0, 2000) })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not create the deep task.");
  return toRow(data);
}

export async function listDeepTasks(limit = 50): Promise<DeepTaskRow[]> {
  const { data } = await getServiceClient()
    .from("deep_tasks")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as any[]).map(toRow);
}

export async function getDeepTask(id: string): Promise<DeepTaskRow | null> {
  const { data } = await getServiceClient()
    .from("deep_tasks")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return data ? toRow(data) : null;
}

export async function getLatestDeepTaskForConversation(
  conversationId: string
): Promise<DeepTaskRow | null> {
  const { data } = await getServiceClient()
    .from("deep_tasks")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? toRow(data) : null;
}

export async function deleteDeepTask(id: string): Promise<void> {
  await getServiceClient().from("deep_tasks").delete().eq("id", id);
}

async function appendProgress(id: string, note: string): Promise<void> {
  const sb = getServiceClient();
  const { data } = await sb.from("deep_tasks").select("progress").eq("id", id).single();
  const progress = Array.isArray((data as any)?.progress) ? (data as any).progress : [];
  progress.push({ at: new Date().toISOString(), note: note.slice(0, 300) });
  await sb
    .from("deep_tasks")
    .update({ progress, heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id);
}

async function postToConversation(conversationId: string | null, content: string): Promise<void> {
  if (!conversationId) return;
  const sb = getServiceClient();
  try {
    await sb.from("messages").insert({ conversation_id: conversationId, role: "assistant", content });
    await sb
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);
  } catch {
    /* report still lives on the task row */
  }
}

/** Break a goal into concrete steps with a cheap tool-less model call. */
async function planDeepTask(goal: string): Promise<{ title: string; detail: string }[]> {
  const fallback = [{ title: "Complete the goal", detail: goal }];
  const modelId = (await getSetting("chat_model").catch(() => null)) || "openai/gpt-oss-120b";
  const primary: KeyProvider = modelId.startsWith("gemini-")
    ? "gemini"
    : modelId.startsWith("google/")
      ? "lovable"
      : "groq";
  const providers: KeyProvider[] = [
    primary,
    ...(["groq", "gemini", "lovable"] as KeyProvider[]).filter((p) => p !== primary),
  ];
  const prompt =
    `Break this goal into 3-8 concrete, verifiable steps. Each step must state what to do and what evidence proves it done. ` +
    `Return ONLY JSON: {"steps":[{"title":"...","detail":"..."}]}. Goal: ${goal}`;
  for (const provider of providers) {
    const candidates = await listCandidateKeys(provider).catch(() => []);
    for (const keyRow of candidates) {
      try {
        const apiKey = decryptRowKey(keyRow);
        const ai =
          provider === "groq"
            ? createGroq({ apiKey })
            : provider === "gemini"
              ? createGoogleGenerativeAI({ apiKey })
              : createOpenAI({
                  baseURL: "https://ai.gateway.lovable.dev/v1",
                  apiKey: "x",
                  headers: { "Lovable-API-Key": apiKey },
                  fetch: lovableFetch,
                });
        const mid =
          provider === "lovable"
            ? "google/gemini-3-flash-preview"
            : provider === "gemini"
              ? "gemini-2.5-flash"
              : "openai/gpt-oss-120b";
        const { text } = await generateText({
          model: provider === "lovable" ? (ai as any).chat(mid) : (ai as any)(mid),
          prompt,
        });
        const json = text.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(json.slice(json.indexOf("{"), json.lastIndexOf("}") + 1));
        const steps = (parsed.steps ?? []).filter(
          (s: any) => s && typeof s.title === "string"
        ) as { title: string; detail: string }[];
        if (steps.length > 0) return steps.slice(0, 8);
      } catch {
        /* try the next key / provider */
      }
    }
  }
  return fallback;
}

function syntheticTask(goal: string, conversationId: string): AgentTask {
  return {
    id: "deep",
    name: "Deep task",
    instructions: goal,
    schedule_kind: "daily",
    time_of_day: null,
    weekday: null,
    interval_minutes: null,
    timezone: "Asia/Karachi",
    enabled: true,
    conversation_id: conversationId,
    last_run_at: null,
    next_run_at: null,
    last_status: null,
    created_at: "",
    updated_at: "",
  };
}

/**
 * Run one deep task end to end: plan → execute (40 steps, 20 min) → report
 * posted into the conversation. Floating: callers use `void` and move on.
 */
export async function runDeepTask(id: string): Promise<{ started: boolean; queued?: boolean }> {
  if (runningDeep.has(id)) return { started: false };
  const sb = getServiceClient();
  const row = await getDeepTask(id);
  if (!row || row.status !== "queued") return { started: false };
  const { count } = await sb
    .from("deep_tasks")
    .select("id", { count: "exact", head: true })
    .eq("status", "running");
  if ((count ?? 0) >= MAX_CONCURRENT) return { started: false, queued: true };

  runningDeep.add(id);
  try {
    await sb
      .from("deep_tasks")
      .update({
        status: "running",
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        attempts: row.attempts + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    await appendProgress(id, "Started");

    const plan = await planDeepTask(row.goal);
    await sb.from("deep_tasks").update({ plan }).eq("id", id);
    await appendProgress(id, `Plan ready: ${plan.length} steps`);

    const conversationId = row.conversation_id ?? "";
    const planText = plan.map((s, i) => `${i + 1}. ${s.title} — ${s.detail}`).join("\n");
    const systemPrompt =
      `You are running a DEEP TASK for Riyan — a long background job, not a quick chat reply. ` +
      `Goal: ${row.goal}\nPlan:\n${planText}\n\n` +
      "Work through the plan step by step with your tools (web, browser, code execution, knowledge base search, site builder, connectors). " +
      "Verify each step from evidence before moving on; never claim a result you did not observe. " +
      "HARD STOPS — stop and report if you hit: a CAPTCHA or bot check, an email/SMS code you cannot read, a payment or anything spending real money, or an irreversible action outside the task. " +
      "End with a complete final report: what was done per step, the evidence observed, and anything still blocked. " +
      "The report is delivered to the user as-is, so write it for them, not for yourself.";

    let stepNo = 0;
    const report = await runGeneration(syntheticTask(row.goal, conversationId), conversationId, systemPrompt, {
      steps: 40,
      timeoutMs: 20 * 60_000,
      onStepFinish: (step: any) => {
        stepNo += 1;
        const names = (step?.toolCalls ?? [])
          .map((t: any) => t.toolName)
          .filter(Boolean)
          .join(", ");
        void appendProgress(id, names ? `Step ${stepNo}: used ${names}` : `Step ${stepNo}: thinking`);
      },
    });

    await sb
      .from("deep_tasks")
      .update({
        status: "done",
        result: report,
        finished_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    await appendProgress(id, "Done — report delivered");
    await postToConversation(row.conversation_id, report);
    return { started: true };
  } catch (e: any) {
    const message = e?.message || String(e);
    await sb
      .from("deep_tasks")
      .update({
        status: "failed",
        error: message.slice(0, 1000),
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    await appendProgress(id, `Failed: ${message.slice(0, 200)}`);
    // The user must never be left wondering — the failure lands in chat too.
    await postToConversation(
      row.conversation_id,
      `Deep task failed: “${row.goal}”\n\n${message}\n\nYou can ask me to retry it, or check the Deep tasks section on the Tasks page.`
    );
    return { started: true };
  } finally {
    runningDeep.delete(id);
  }
}

/**
 * Tick safety net: requeue stale runs (server restarted mid-task) and start
 * queued tasks up to the concurrency cap. Called by the 5-minute cron tick.
 */
export async function runQueuedDeepTasks(): Promise<{ started: string[] }> {
  const sb = getServiceClient();
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data: stale } = await sb
    .from("deep_tasks")
    .select("*")
    .eq("status", "running")
    .lt("heartbeat_at", staleBefore);
  for (const row of (stale ?? []) as DeepTaskRow[]) {
    if (row.attempts >= MAX_ATTEMPTS) {
      await sb
        .from("deep_tasks")
        .update({ status: "failed", error: "Interrupted repeatedly (server restarted mid-run)", finished_at: new Date().toISOString() })
        .eq("id", row.id);
      await postToConversation(
        row.conversation_id,
        `Deep task failed: “${row.goal}”\n\nIt was interrupted repeatedly while running. Ask me to retry it when you're ready.`
      );
    } else {
      await sb.from("deep_tasks").update({ status: "queued" }).eq("id", row.id);
      await appendProgress(row.id, "Restarted after an interruption");
    }
  }

  const { count } = await sb
    .from("deep_tasks")
    .select("id", { count: "exact", head: true })
    .eq("status", "running");
  const slots = Math.max(0, MAX_CONCURRENT - (count ?? 0));
  const started: string[] = [];
  if (slots > 0) {
    const { data: queued } = await sb
      .from("deep_tasks")
      .select("*")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(slots);
    for (const row of (queued ?? []) as DeepTaskRow[]) {
      if (runningDeep.has(row.id)) continue;
      started.push(row.goal);
      void runDeepTask(row.id);
    }
  }
  return { started };
}

export function isDeepTaskRunning(id: string): boolean {
  return runningDeep.has(id);
}
