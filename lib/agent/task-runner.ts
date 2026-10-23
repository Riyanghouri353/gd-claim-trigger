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
import { listSubmissions } from "./submissions";
import { startSitePreview, stopSitePreview } from "./site-preview";
import { pyBrowserAction, apiTest, runSiteTest } from "./pybrowser";
import { listTestAccounts, generateTestIdentity } from "./test-accounts";

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
    "If something blocks you, say exactly what in the report instead of failing silently." +
    "\n\nSITE TESTING PROTOCOL (when the task involves testing a site, form, flow or API): think before acting — plan the steps and what you EXPECT at each one; inspect pages (py_browser action=inspect) for real selectors before filling; execute multi-step flows with run_site_test so expectations are checked and failures stop with a screenshot; verify outcomes from evidence (result page, API response, submissions inbox), never assume; on failure, form a hypothesis from the screenshot/page text, change ONE thing, retry at most twice, then report the blocker with evidence. The report must give a per-step pass/fail with observed values." +
    "\n\nACCOUNT FLOWS + WEB TASKS: logins use the Test accounts vault — list_test_accounts (never shows passwords); fill credentials ONLY via {{account:email:<site>}} / {{account:username:<site>}} / {{account:password:<site>}} tokens. For sign-ups with no stored account, generate_test_identity creates + stores one, then use its tokens. Verify logged-in/success states from evidence (page text, URL, account indicator) and name the account used (email/username) in the report. HARD STOPS — report and stop at: CAPTCHAs, email/SMS codes you cannot read, payments or anything spending real money, irreversible actions outside the task." +
    "\n\nNETWORK INTERCEPTION: py_browser net_log shows the requests a page made (method/URL/status/payload/response body) — use it to prove a form really called its API. net_intercept (pattern = URL substring or * glob; set it BEFORE the triggering action) rewrites traffic: mode=mock answers with your status/body (error & edge-case tests without touching the backend), mode=block aborts matches, mode=modify rewrites the request (newUrl, addHeaders, removeHeaders, method, postData — e.g. strip Authorization on the user's own site and verify rejection). Rules persist until net_stop — always net_stop at the end and state which rules were active. evaluate runs JavaScript in the page when clicks can't reach what you need.";
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
      description: "Create or overwrite one file of a website (by slug): app/ pages, components/ custom components (compose @/components/ui library), lib/ mock data. Frontend only. For forms that must SAVE data use LeadForm/submitForm from @/components/site/lead-form — never a fake onSubmit.",
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
    list_site_submissions: tool({
      description: "Read a website's form submissions (by slug): contact messages, orders, bookings sent from the site's forms. Ideal for order/lead digests.",
      inputSchema: z.object({
        site: z.string(),
        limit: z.number().optional(),
        unreadOnly: z.boolean().optional(),
      }),
      execute: async ({ site, limit, unreadOnly }) => {
        const s = await resolveSite(site);
        if (!s) return { ok: false, error: `Site "${site}" not found` };
        const rows = await listSubmissions(s.id, limit ?? 20, unreadOnly ?? false);
        return {
          ok: true,
          site: s.slug,
          count: rows.length,
          submissions: rows.map((r) => ({
            form: r.form_name,
            at: r.created_at,
            read: r.is_read,
            data: r.data,
          })),
        };
      },
    }),
    preview_site: tool({
      description: "Build and serve a website (by slug) in an E2B sandbox; returns a public preview URL (~10 min) and a Python smoke-test result. On build failure returns the build log.",
      inputSchema: z.object({ site: z.string() }),
      execute: async ({ site }) => startSitePreview(site),
    }),
    stop_preview: tool({
      description: "Stop a website's live preview sandbox (by slug).",
      inputSchema: z.object({ site: z.string() }),
      execute: async ({ site }) => {
        const s = await resolveSite(site);
        if (!s) return { ok: false, error: `Site "${site}" not found` };
        return stopSitePreview(s.id);
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
    tools.list_test_accounts = tool({
      description: "List vault test accounts (site/label/email/username — never passwords). Fill credential fields with tokens {{account:email:<site>}}, {{account:username:<site>}}, {{account:password:<site>}} — the server substitutes the secret inside the browser.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return { ok: true, accounts: await listTestAccounts() };
        } catch (e: any) {
          return { ok: false, error: e?.message || "Could not list accounts" };
        }
      },
    });
    tools.generate_test_identity = tool({
      description: "Create + store a fresh test identity for a site (sign-up flows): returns email/username (password stays in the vault, used via tokens). The same stored account works for later logins.",
      inputSchema: z.object({ site: z.string(), label: z.string().optional() }),
      execute: async ({ site, label }) => {
        try {
          const account = await generateTestIdentity(site, label);
          return { ok: true, account };
        } catch (e: any) {
          return { ok: false, error: e?.message || "Could not generate identity" };
        }
      },
    });
    tools.py_browser = tool({
      description: "Python (Playwright) browser automation — PREFER for form filling/precise interaction (DOM selectors, not pixels). Actions: open/inspect/fill/type/click/submit/press/scroll/wait_for/read/screenshot/close + NETWORK: net_log (requests the page made: method/URL/status/payload/response body, filter urlContains/method/limit), net_intercept (pattern + mode: mock answers with your status/body, block aborts, modify rewrites newUrl/addHeaders/removeHeaders/method/postData — set BEFORE the triggering action), net_rules, net_stop (clear rules), net_clear (clear log), evaluate (run JS in the page, async ok). inspect maps the page's forms/fields/buttons + selectors — use it before filling. fill returns the field's read-back value (masked for password tokens). CREDENTIALS: fill with tokens {{account:email:<site>}} / {{account:username:<site>}} / {{account:password:<site>}} — never type a real password yourself. Session persists across calls. Link any screenshotPath in the report.",
      inputSchema: z.object({
        action: z.enum(["open", "inspect", "fill", "type", "click", "submit", "press", "scroll", "wait_for", "read", "screenshot", "close", "net_log", "net_clear", "net_intercept", "net_rules", "net_stop", "evaluate"]),
        url: z.string().optional(),
        selector: z.string().optional(),
        value: z.string().optional(),
        key: z.string().optional(),
        direction: z.enum(["up", "down"]).optional(),
        amount: z.number().optional(),
        text: z.string().optional(),
        urlContains: z.string().optional(),
        ms: z.number().optional(),
        screenshot: z.boolean().optional(),
        pattern: z.string().optional(),
        mode: z.enum(["mock", "block", "modify"]).optional(),
        status: z.number().optional(),
        body: z.string().optional(),
        contentType: z.string().optional(),
        newUrl: z.string().optional(),
        addHeaders: z.record(z.string(), z.string()).optional(),
        removeHeaders: z.array(z.string()).optional(),
        postData: z.string().optional(),
        script: z.string().optional(),
        limit: z.number().optional(),
        withBody: z.boolean().optional(),
      }),
      execute: async (args) => {
        try {
          return await pyBrowserAction(e2bKey, conversationId, args.action, args);
        } catch (e: any) {
          return { ok: false, error: `Python browser failed: ${e?.message || e}` };
        }
      },
    });
    tools.run_site_test = tool({
      description: "Run a PLANNED site test (array of steps with optional expect {textContains, urlContains, titleContains, valueEquals}) in the py_browser session. Stops at the first failure with a screenshot + observed values. Inspect the page first for real selectors, then encode the plan.",
      inputSchema: z.object({
        steps: z.array(
          z.object({
            action: z.enum(["open", "inspect", "fill", "type", "click", "submit", "press", "scroll", "wait_for", "read", "screenshot", "net_log", "net_clear", "net_intercept", "net_rules", "net_stop", "evaluate"]),
            url: z.string().optional(),
            selector: z.string().optional(),
            value: z.string().optional(),
            key: z.string().optional(),
            direction: z.enum(["up", "down"]).optional(),
            amount: z.number().optional(),
            pattern: z.string().optional(),
            mode: z.enum(["mock", "block", "modify"]).optional(),
            status: z.number().optional(),
            body: z.string().optional(),
            contentType: z.string().optional(),
            newUrl: z.string().optional(),
            addHeaders: z.record(z.string(), z.string()).optional(),
            removeHeaders: z.array(z.string()).optional(),
            postData: z.string().optional(),
            script: z.string().optional(),
            note: z.string().optional(),
            expect: z.object({
              textContains: z.string().optional(),
              urlContains: z.string().optional(),
              titleContains: z.string().optional(),
              valueEquals: z.string().optional(),
            }).optional(),
          })
        ).min(1).max(25),
      }),
      execute: async ({ steps }) => {
        try {
          return await runSiteTest(e2bKey, conversationId, steps as any);
        } catch (e: any) {
          return { ok: false, error: `Site test failed: ${e?.message || e}` };
        }
      },
    });
    tools.api_test = tool({
      description: "Test HTTP APIs with Python requests: single call (method/url/headers/body + expectStatus/bodyContains/jsonPath/jsonEquals) or multi-step via steps[] with extract {var: 'json.path'} and {{var}} substitution in later steps (login -> token -> protected call). Returns per-step status, checks, extracted var names.",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
        url: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.any().optional(),
        expectStatus: z.number().optional(),
        bodyContains: z.string().optional(),
        jsonPath: z.string().optional(),
        jsonEquals: z.any().optional(),
        steps: z.array(
          z.object({
            method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
            url: z.string(),
            headers: z.record(z.string(), z.string()).optional(),
            body: z.any().optional(),
            expectStatus: z.number().optional(),
            bodyContains: z.string().optional(),
            jsonPath: z.string().optional(),
            jsonEquals: z.any().optional(),
            extract: z.record(z.string(), z.string()).optional(),
          })
        ).optional(),
      }),
      execute: async (spec) => {
        try {
          if (!spec.steps?.length && !spec.url) {
            return { ok: false, error: "api_test needs a url (single call) or a steps array (multi-step flow)" };
          }
          return await apiTest(e2bKey, spec as any);
        } catch (e: any) {
          return { ok: false, error: `API test failed: ${e?.message || e}` };
        }
      },
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
