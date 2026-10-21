import { generateText, stepCountIs, tool } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { getServiceClient, type Database } from "./supabase";

type AgentTaskUpdate = Database["public"]["Tables"]["agent_tasks"]["Update"];
import {
  listCandidateKeys,
  decryptRowKey,
  markKeyUsed,
  cooldownKey,
  disableKey,
  getSetting,
  type KeyProvider,
} from "./keys";
import { listConnectors, callConnector } from "./connectors";
import { listMemories, addMemory } from "./memory";
import { fetchPublicText } from "./web";
import { createAgentFile } from "./files";
import { getE2BKey, runCode } from "./e2b";
import { browsePage, browserOpen, browserAct, browserClose } from "./browser";
import {
  createSite,
  writeSiteFile,
  listSiteFiles,
  readSiteFile,
  resolveSite,
  deploySite,
  SITE_APEX,
} from "./sites";
import {
  createTask,
  listTasks,
  computeNextRun,
  describeSchedule,
  type AgentTask,
} from "./tasks";

/**
 * Headless task execution: runs an agent_tasks job with (nearly) the same
 * brain and tools as chat — providers with fallback, memory, connectors,
 * web, code, browser, website builder — then delivers the final report
 * into the task's dedicated conversation.
 */

const runningTasks = new Set<string>();

const lovableFetch = async (url: any, init: any): Promise<Response> => {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  return fetch(url, { ...init, headers });
};

const DEFAULT_MODEL: Record<KeyProvider, string> = {
  groq: "openai/gpt-oss-120b",
  gemini: "gemini-2.5-flash",
  lovable: "google/gemini-3-flash-preview",
};

function errStatus(e: any): number {
  return e?.status ?? e?.response?.status ?? e?.statusCode ?? 0;
}

async function buildSystemPrompt(task: AgentTask): Promise<string> {
  let prompt =
    (await getSetting("system_prompt")) ||
    "You are Riyan's personal AI assistant. Be warm, direct, technically sharp.";
  try {
    const conns = (await listConnectors()).filter((c) => c.enabled);
    if (conns.length) {
      prompt +=
        "\n\nSaved API connectors you can call with the call_connector tool: " +
        conns.map((c) => `"${c.name}" (${c.baseUrl})`).join(", ") +
        ". Never reveal keys — they stay server-side.";
    }
  } catch {}
  try {
    const mems = await listMemories(40);
    if (mems.length) {
      prompt +=
        "\n\nThings you remember about the user from past conversations:\n" +
        mems.map((m) => `- ${m.content}`).join("\n");
    }
  } catch {}
  const now = new Date();
  prompt +=
    `\n\nYou are running as a SCHEDULED AUTONOMOUS TASK named "${task.name}". ` +
    `Schedule: ${describeSchedule(task)}. Current time: ${now.toLocaleString("en-GB", { timeZone: task.timezone })} (${task.timezone}), UTC ${now.toISOString()}. ` +
    "There is no user present. Execute the instructions completely using your tools, then write a clear final report as your last message — that report is what gets delivered to the user. " +
    "Text only: no visual guides. If you take browser screenshots, link the most useful one in the report as ![screenshot](screenshotPath). " +
    "If something blocks you, say exactly what in the report instead of failing silently.";
  return prompt;
}

function buildTools(task: AgentTask, conversationId: string, e2bKey: string | null) {
  const tools: Record<string, any> = {
    get_current_time: tool({
      description: "Get the current date and time",
      inputSchema: z.object({}),
      execute: async () => ({
        now: new Date().toLocaleString("en-GB", { timeZone: task.timezone }),
        timezone: task.timezone,
        utc: new Date().toISOString(),
      }),
    }),
    read_url: tool({
      description: "Fetch a web page as readable text (no JavaScript execution)",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        try {
          const r = await fetchPublicText(url);
          return { ok: r.ok, status: r.status, text: r.text, truncated: r.truncated };
        } catch (e: any) {
          return { ok: false, status: 0, text: `Read failed: ${e?.message || e}`, truncated: false };
        }
      },
    }),
    call_connector: tool({
      description:
        "Call a saved API connector (Settings). Key injected server-side. Returns { ok, status, body, truncated } with compact valid JSON. For list endpoints pass query { per_page: '20' }. Never repeat an identical call.",
      inputSchema: z.object({
        connector: z.string(),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string(),
        query: z.record(z.string(), z.string()).optional(),
        body: z.any().optional(),
      }),
      execute: async ({ connector, method, path, query, body }) => {
        try {
          const r = await callConnector(connector, method, path, query, body);
          return { ok: r.ok, status: r.status, body: r.body, truncated: r.truncated };
        } catch (e: any) {
          return { ok: false, status: 0, body: `Connector error: ${e?.message || e}`, truncated: false };
        }
      },
    }),
    remember: tool({
      description: "Save a durable fact about the user to long-term memory. Never save passwords or API keys.",
      inputSchema: z.object({ fact: z.string() }),
      execute: async ({ fact }) => {
        const ok = await addMemory(fact).catch(() => false);
        return { ok };
      },
    }),
    create_file: tool({
      description: "Create a downloadable text file for the user; returns a download path to link in the report.",
      inputSchema: z.object({ name: z.string(), content: z.string() }),
      execute: async ({ name, content }) => {
        try {
          const f = await createAgentFile(name, content, conversationId);
          return { ok: true, name, download: f.path };
        } catch (e: any) {
          return { ok: false, error: e?.message || "Could not create file" };
        }
      },
    }),
    create_site: tool({
      description: "Create a frontend-only Next.js website (shadcn/ui scaffold). Slug = its <slug>." + SITE_APEX + " subdomain.",
      inputSchema: z.object({ name: z.string(), slug: z.string().optional() }),
      execute: async ({ name, slug }) => {
        try {
          const { site, fileCount } = await createSite(name, slug);
          return { ok: true, site: site.slug, name: site.name, scaffoldFiles: fileCount };
        } catch (e: any) {
          return { ok: false, error: e?.message || "Could not create site" };
        }
      },
    }),
    write_site_file: tool({
      description: "Create or overwrite one file of a website (by slug): app/ pages, components/ custom components (compose @/components/ui library), lib/ mock data. Frontend only.",
      inputSchema: z.object({ site: z.string(), path: z.string(), content: z.string() }),
      execute: async ({ site, path, content }) => {
        try {
          const s = await resolveSite(site);
          if (!s) return { ok: false, error: `Site "${site}" not found` };
          const r = await writeSiteFile(s.id, path, content);
          return { ok: true, site: s.slug, ...r };
        } catch (e: any) {
          return { ok: false, error: e?.message || "Could not write file" };
        }
      },
    }),
    list_site_files: tool({
      description: "List a website's files (by slug).",
      inputSchema: z.object({ site: z.string() }),
      execute: async ({ site }) => {
        const s = await resolveSite(site);
        if (!s) return { ok: false, error: `Site "${site}" not found` };
        return { ok: true, site: s.slug, files: await listSiteFiles(s.id) };
      },
    }),
    read_site_file: tool({
      description: "Read one file of a website (by slug).",
      inputSchema: z.object({ site: z.string(), path: z.string() }),
      execute: async ({ site, path }) => {
        const s = await resolveSite(site);
        if (!s) return { ok: false, error: `Site "${site}" not found` };
        const content = await readSiteFile(s.id, path);
        if (content === null) return { ok: false, error: `No file ${path}` };
        return { ok: true, site: s.slug, path, content: content.slice(0, 12000) };
      },
    }),
    deploy_site: tool({
      description: "Deploy a website (by slug) to Vercel. target=preview for a preview URL; target=production publishes to https://<slug>." + SITE_APEX + " — production ONLY if the task instructions explicitly say to publish.",
      inputSchema: z.object({
        site: z.string(),
        target: z.enum(["preview", "production"]).default("preview"),
      }),
      execute: async ({ site, target }) => {
        try {
          return await deploySite(site, target);
        } catch (e: any) {
          return { ok: false, target, error: e?.message || "Deploy failed" };
        }
      },
    }),
    create_task: tool({
      description: "Create another scheduled task (e.g. the user asked for a recurring job). Schedules: daily/weekly at time_of_day HH:MM in a timezone, or interval every interval_minutes (min 15).",
      inputSchema: z.object({
        name: z.string(),
        instructions: z.string(),
        schedule_kind: z.enum(["daily", "weekly", "interval"]),
        time_of_day: z.string().optional(),
        weekday: z.number().min(0).max(6).optional().describe("0=Sunday … 6=Saturday (weekly)"),
        interval_minutes: z.number().optional(),
        timezone: z.string().optional(),
      }),
      execute: async (input) => {
        try {
          const t = await createTask({ ...input, timezone: input.timezone || "Asia/Karachi" });
          return { ok: true, id: t.id, name: t.name, schedule: describeSchedule(t), nextRun: t.next_run_at };
        } catch (e: any) {
          return { ok: false, error: e?.message || "Could not create task" };
        }
      },
    }),
    list_tasks: tool({
      description: "List the user's scheduled tasks with schedules and last status.",
      inputSchema: z.object({}),
      execute: async () => {
        const all = await listTasks();
        return {
          ok: true,
          tasks: all.map((t) => ({
            name: t.name,
            schedule: describeSchedule(t),
            enabled: t.enabled,
            lastStatus: t.last_status,
            nextRun: t.next_run_at,
          })),
        };
      },
    }),
  };

  if (e2bKey) {
    tools.run_code = tool({
      description: "Run Python or JavaScript in an E2B cloud sandbox. Returns stdout/stderr/results.",
      inputSchema: z.object({
        code: z.string(),
        language: z.enum(["python", "javascript"]).default("python"),
      }),
      execute: async ({ code, language }) => {
        try {
          return await runCode(e2bKey, code, language);
        } catch (e: any) {
          return { stdout: "", stderr: "", results: [], error: e?.message || "Run failed" };
        }
      },
    });
    tools.browse_page = tool({
      description: "Render a page in real Chrome (JS executed) and extract readable text; optional screenshot (stored; its path is returned for linking).",
      inputSchema: z.object({ url: z.string(), screenshot: z.boolean().default(false) }),
      execute: async ({ url, screenshot }) => {
        try {
          return await browsePage(e2bKey, conversationId, url, screenshot);
        } catch (e: any) {
          return { ok: false, error: `Browse failed: ${e?.message || e}` };
        }
      },
    });
    tools.browser_open = tool({
      description: "Open a page in the interactive cloud browser; returns a screenshot path + title.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        try {
          return await browserOpen(e2bKey, conversationId, url);
        } catch (e: any) {
          return { ok: false, error: `Browser failed: ${e?.message || e}` };
        }
      },
    });
    tools.browser_act = tool({
      description: "One action in the interactive browser: navigate/click/type/press/scroll/screenshot. Returns a fresh screenshot path.",
      inputSchema: z.object({
        action: z.enum(["navigate", "click", "type", "press", "scroll", "screenshot"]),
        url: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        text: z.string().optional(),
        key: z.string().optional(),
        direction: z.enum(["up", "down"]).optional(),
      }),
      execute: async (input) => {
        try {
          return await browserAct(e2bKey, conversationId, input.action, input);
        } catch (e: any) {
          return { ok: false, error: `Browser action failed: ${e?.message || e}` };
        }
      },
    });
    tools.browser_close = tool({
      description: "Close the interactive browser session.",
      inputSchema: z.object({}),
      execute: async () => browserClose(conversationId),
    });
  }

  // Web search is provider-specific; it is attached in runGeneration where
  // the provider client instance exists.
  return tools;
}

async function ensureConversation(task: AgentTask): Promise<string> {
  const sb = getServiceClient();
  if (task.conversation_id) {
    const { data } = await sb
      .from("conversations")
      .select("id")
      .eq("id", task.conversation_id)
      .maybeSingle();
    if (data) return task.conversation_id;
  }
  const { data, error } = await sb
    .from("conversations")
    .insert({ title: `⏰ ${task.name}`.slice(0, 80) })
    .select("id")
    .single();
  if (error || !data) throw new Error("Could not create task conversation");
  await sb.from("agent_tasks").update({ conversation_id: data.id }).eq("id", task.id);
  task.conversation_id = data.id;
  return data.id;
}

async function runGeneration(
  task: AgentTask,
  conversationId: string,
  systemPrompt: string
): Promise<string> {
  const modelId = (await getSetting("chat_model")) || "openai/gpt-oss-120b";
  const primary: KeyProvider = modelId.startsWith("gemini-")
    ? "gemini"
    : modelId.startsWith("google/")
      ? "lovable"
      : "groq";
  const providers: KeyProvider[] = [
    primary,
    ...(["groq", "gemini", "lovable"] as KeyProvider[]).filter((p) => p !== primary),
  ];
  const e2bKey = await getE2BKey().catch(() => null);
  let lastError: unknown = null;

  for (const provider of providers) {
    const mid = provider === primary ? modelId : DEFAULT_MODEL[provider];
    const candidates = await listCandidateKeys(provider);
    for (const keyRow of candidates) {
      const apiKey = decryptRowKey(keyRow);
      const ai =
        provider === "groq"
          ? createGroq({ apiKey })
          : provider === "gemini"
            ? createGoogleGenerativeAI({ apiKey })
            : createOpenAI({
                baseURL: "https://ai.gateway.lovable.dev/v1",
                apiKey: "unused",
                headers: { "Lovable-API-Key": apiKey },
                fetch: lovableFetch,
              });
      const tools = buildTools(task, conversationId, e2bKey);
      try {
        if (provider === "groq") {
          const maybeSearch = (ai as any)?.tools?.browserSearch;
          if (typeof maybeSearch === "function") tools.web_search = maybeSearch({});
        } else if (provider === "gemini") {
          const { google } = await import("@ai-sdk/google");
          const maybeSearch = (google as any)?.tools?.googleSearch;
          if (typeof maybeSearch === "function") tools.web_search = maybeSearch({});
        }
      } catch {
        /* web search unavailable */
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 240_000);
      try {
        const result = await generateText({
          model: provider === "lovable" ? (ai as any).chat(mid) : (ai as any)(mid),
          system: systemPrompt,
          prompt: task.instructions,
          tools,
          stopWhen: stepCountIs(15),
          abortSignal: controller.signal,
        });
        clearTimeout(timer);
        await markKeyUsed(keyRow.id, provider).catch(() => {});
        const text = (result.text || "").trim();
        if (text) return text;
        const stepCount = result.steps?.length ?? 0;
        return `Task finished after ${stepCount} step(s) but produced no text report — consider adding "always end with a written summary" to the task instructions.`;
      } catch (e: any) {
        clearTimeout(timer);
        lastError = e;
        const status = errStatus(e);
        if (status === 401 || status === 403) {
          await disableKey(keyRow.id, provider).catch(() => {});
        } else if (status === 429) {
          await cooldownKey(keyRow.id, 120, provider).catch(() => {});
        }
        // try the next key / provider
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All providers failed");
}

async function executeTask(task: AgentTask, advanceSchedule: boolean): Promise<void> {
  if (runningTasks.has(task.id)) return;
  runningTasks.add(task.id);
  const sb = getServiceClient();
  let runId: string | null = null;
  try {
    const ins = await sb
      .from("agent_task_runs")
      .insert({ task_id: task.id, status: "running" })
      .select("id")
      .single();
    runId = ins.data?.id ?? null;

    const conversationId = await ensureConversation(task);
    const systemPrompt = await buildSystemPrompt(task);
    const report = await runGeneration(task, conversationId, systemPrompt);

    const stamp = new Date().toLocaleString("en-GB", { timeZone: task.timezone });
    await sb.from("messages").insert([
      {
        conversation_id: conversationId,
        role: "user",
        content: `⏰ Scheduled run (${stamp})\n\n${task.instructions}`,
      },
      { conversation_id: conversationId, role: "assistant", content: report },
    ]);
    await sb
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    if (runId) {
      await sb
        .from("agent_task_runs")
        .update({
          status: "ok",
          finished_at: new Date().toISOString(),
          result_excerpt: report.slice(0, 500),
        })
        .eq("id", runId);
    }
    const patch: AgentTaskUpdate = {
      last_run_at: new Date().toISOString(),
      last_status: "ok",
      updated_at: new Date().toISOString(),
    };
    if (advanceSchedule) {
      patch.next_run_at = computeNextRun(task, new Date()).toISOString();
    }
    await sb.from("agent_tasks").update(patch).eq("id", task.id);
  } catch (e: any) {
    const message = e?.message || String(e);
    if (runId) {
      try {
        await sb
          .from("agent_task_runs")
          .update({ status: "error", finished_at: new Date().toISOString(), error: message.slice(0, 500) })
          .eq("id", runId);
      } catch {}
    }
    const patch: AgentTaskUpdate = {
      last_run_at: new Date().toISOString(),
      last_status: "error",
      updated_at: new Date().toISOString(),
    };
    if (advanceSchedule) {
      patch.next_run_at = computeNextRun(task, new Date()).toISOString();
    }
    try {
      await sb.from("agent_tasks").update(patch).eq("id", task.id);
    } catch {}
    console.error(`agent task ${task.name} failed:`, message);
  } finally {
    runningTasks.delete(task.id);
  }
}

/**
 * Start every due task (floating — returns immediately; the work continues
 * server-side, the same pattern as the claim app's background runs).
 */
export async function runDueTasks(limit = 3): Promise<{ started: string[] }> {
  const sb = getServiceClient();
  // Mark runs orphaned by a server restart
  const staleBefore = new Date(Date.now() - 20 * 60_000).toISOString();
  await sb
    .from("agent_task_runs")
    .update({ status: "error", finished_at: new Date().toISOString(), error: "Interrupted (server restarted mid-run)" })
    .eq("status", "running")
    .lt("started_at", staleBefore);

  const { data } = await sb
    .from("agent_tasks")
    .select("*")
    .eq("enabled", true)
    .not("next_run_at", "is", null)
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(limit);
  const started: string[] = [];
  for (const task of (data as AgentTask[]) ?? []) {
    if (runningTasks.has(task.id)) continue;
    started.push(task.name);
    void executeTask(task, true);
  }
  return { started };
}

/** Manually run one task now (does not shift its schedule). */
export async function runTaskNow(id: string): Promise<{ ok: boolean; error?: string }> {
  const { data } = await getServiceClient()
    .from("agent_tasks")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!data) return { ok: false, error: "Task not found" };
  if (runningTasks.has(id)) return { ok: false, error: "Task is already running" };
  void executeTask(data as AgentTask, false);
  return { ok: true };
}

export function isTaskRunning(id: string): boolean {
  return runningTasks.has(id);
}
