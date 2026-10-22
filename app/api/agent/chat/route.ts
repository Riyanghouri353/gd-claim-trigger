import { streamText, convertToModelMessages, stepCountIs, tool } from "ai";
import { NextResponse } from "next/server";
import { createGroq } from "@ai-sdk/groq";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { requireSession } from "@/lib/agent/auth";
import { getServiceClient } from "@/lib/agent/supabase";
import {
  listCandidateKeys,
  decryptRowKey,
  markKeyUsed,
  cooldownKey,
  disableKey,
  getSetting,
  type KeyProvider,
} from "@/lib/agent/keys";
import { listConnectors, callConnector } from "@/lib/agent/connectors";
import { listMemories, addMemory } from "@/lib/agent/memory";
import { fetchPublicText } from "@/lib/agent/web";
import { createAgentFile } from "@/lib/agent/files";
import { getE2BKey, runCode } from "@/lib/agent/e2b";
import { browsePage, browserOpen, browserAct, browserClose, getCachedScreenshot } from "@/lib/agent/browser";
import { pyBrowserAction, apiTest, runSiteTest } from "@/lib/agent/pybrowser";
import { listTestAccounts, generateTestIdentity } from "@/lib/agent/test-accounts";
import {
  createSite,
  writeSiteFile,
  listSiteFiles,
  readSiteFile,
  resolveSite,
  deploySite,
  SITE_APEX,
} from "@/lib/agent/sites";
import { createTask, listTasks, describeSchedule } from "@/lib/agent/tasks";
import { listSubmissions } from "@/lib/agent/submissions";
import { startSitePreview, stopSitePreview } from "@/lib/agent/site-preview";

export const maxDuration = 60;

function errorInfo(err: unknown): { status?: number; retryAfter?: number } {
  const e = err as any;
  const status: number | undefined =
    e?.status ?? e?.statusCode ?? e?.response?.status ?? e?.cause?.status;
  const raw =
    e?.responseHeaders?.["retry-after"] ??
    e?.headers?.["retry-after"] ??
    e?.cause?.responseHeaders?.["retry-after"];
  let retryAfter: number | undefined;
  if (raw != null) {
    const n = parseInt(String(raw), 10);
    if (!Number.isNaN(n) && n > 0) retryAfter = n;
  }
  return {
    status: typeof status === "number" ? status : undefined,
    retryAfter,
  };
}

/**
 * Fetch wrapper for the Lovable gateway: strips the SDK's forced
 * `Authorization: Bearer` header. The gateway only accepts its own
 * `Lovable-API-Key` header (sending both breaks auth).
 */
const lovableFetch = async (url: any, init: any): Promise<Response> => {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  return fetch(url, { ...init, headers });
};

/** Human-readable error message sent to the chat client on stream failure. */
function streamErrorMessage(error: unknown): string {
  const e = error as any;
  const { status } = errorInfo(error);
  if (status === 429) return "Rate limit hit on all providers — wait a few seconds and hit Retry.";
  if (status === 401 || status === 403)
    return "API key rejected by the provider. Check Settings → Keys.";
  // Gateway error bodies (OpenAI-style or flat) carry a readable message.
  try {
    const body = typeof e?.responseBody === "string" ? JSON.parse(e.responseBody) : null;
    const m = body?.message || body?.title || body?.error?.message;
    if (m) return `Provider error: ${String(m).slice(0, 220)}`;
  } catch { /* fall through */ }
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (/network|fetch failed|econn|etimedout|enotfound|socket/i.test(msg))
    return "Network error reaching the AI provider. Check your connection and hit Retry.";
  return `Provider error: ${msg.slice(0, 220)}`;
}

async function persistTurn(conversationId: string, messages: any[], assistantText: string) {
  try {
    const sb = getServiceClient();
    const lastUser = [...messages].reverse().find((m: any) => m?.role === "user");
    const userText =
      lastUser?.parts
        ?.filter((p: any) => p?.type === "text")
        .map((p: any) => p.text)
        .join("\n") ?? "";
    if (userText) {
      await sb.from("messages").insert({ conversation_id: conversationId, role: "user", content: userText });
    }
    if (assistantText) {
      await sb.from("messages").insert({ conversation_id: conversationId, role: "assistant", content: assistantText });
    }
    // Auto-title a fresh conversation from its first message
    const { count } = await sb
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversationId);
    if (count !== null && count <= 2 && userText) {
      await sb
        .from("conversations")
        .update({ title: userText.slice(0, 60) })
        .eq("id", conversationId);
    }
  } catch (e) {
    console.error("persistTurn failed", e);
  }
}

export async function POST(req: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { messages, conversationId } = await req.json();
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "No messages" }, { status: 400 });
  }

  const modelMessages = await convertToModelMessages(messages);
  const modelId = (await getSetting("chat_model")) || "openai/gpt-oss-120b";
  let systemPrompt =
    (await getSetting("system_prompt")) ||
    "You are Riyan's personal AI assistant. Be warm, direct, technically sharp. " +
      "Never open with a canned greeting (no 'Hey there! How can I help you today?') and never list your capabilities unless the user explicitly asks what you can do. " +
      "Just answer the message naturally and briefly, like texting a smart friend — a greeting like 'hy' gets a short friendly reply, not a brochure. " +
      "Match the user's language. Use code blocks for code, and use your tools when they help. " +
      "After a tool returns data, ALWAYS present it to the user as a clean formatted summary in chat (lists, short tables) — never end your turn with only tool calls and no text.";

  // Tell the model which API connectors exist so it can call them.
  try {
    const conns = (await listConnectors()).filter((c) => c.enabled);
    if (conns.length > 0) {
      systemPrompt +=
        "\n\nSaved API connectors you can call with the call_connector tool: " +
        conns.map((c) => `"${c.name}" (${c.baseUrl})`).join(", ") +
        ". Use them whenever the user asks about a connected service. Never reveal keys — they stay server-side.";
    }
  } catch {
    /* connectors unavailable — chat still works */
  }

  // Long-term memory: inject what the agent remembers about the user.
  try {
    const mems = await listMemories(40);
    if (mems.length > 0) {
      systemPrompt +=
        "\n\nThings you remember about the user from past conversations:\n" +
        mems.map((m) => `- ${m.content}`).join("\n") +
        "\nUse these naturally when relevant; don't recite them unbidden.";
    }
  } catch {
    /* memory unavailable — chat still works */
  }

  const e2bKey = await getE2BKey().catch(() => null);

  systemPrompt +=
    "\n\nVisual guides: when your answer describes a structure, architecture, process, comparison, or step-by-step overview, call the show_guide tool to present it as visual cards with flow arrows (ChatGPT-style diagram), then summarize briefly in text. Do not repeat the whole guide as a long plain-text list.";

  if (e2bKey) {
    systemPrompt +=
      "\n\nBrowser automation: you have browse_page (renders a page in real Chrome — JavaScript included — and reads it; can also screenshot) and an interactive browser (browser_open, browser_act, browser_close): a live cloud desktop you control with clicks (pixel coordinates on the screenshot), typing and key presses. Screenshots are shown to the user after every action, and a Watch-live link lets them observe. Prefer read_url for simple static pages; use the browser when a page needs JavaScript, interaction, or visual proof. To go to a new page inside the interactive browser, use browser_act with action=navigate and the URL." +
      "\n\nPython automation (py_browser + api_test): for FORM FILLING and precise page interaction prefer py_browser — a Playwright (Python) browser driven by DOM selectors (fill/click/submit/scroll), far more reliable than pixel clicks; use the desktop browser only when a page needs visual aiming. Use api_test to verify HTTP APIs with assertions (status, body, JSON paths) instead of eyeballing raw responses." +
      "\n\nSITE TESTING PROTOCOL — when the user asks you to test a website, form, flow or API, work like a QA engineer who thinks before acting: (1) PLAN FIRST: state the goal and the steps you will run, with what you EXPECT to observe at each step, before touching anything. (2) INSPECT before interacting: py_browser action=inspect returns the page's real forms, fields, buttons and correct selectors — never guess selectors blind. (3) EXECUTE the plan with run_site_test for multi-step flows (it checks your expectations and stops with a screenshot on failure); use py_browser step-by-step only when exploring. (4) VERIFY outcomes, never assume them: a form counts as passed only when the result page, an API response, or the site's submissions inbox (list_site_submissions) proves the data landed. (5) DIAGNOSE before retrying: on failure, read the screenshot and page text, state your hypothesis (wrong selector, validation message, element below the fold -> scroll, slow page -> wait_for), change ONE thing, and retry — at most 2 retries per step, then report the blocker with the evidence. (6) REPORT a per-step pass/fail summary with the concrete evidence you observed (URLs, values read back, response codes), not just 'it worked'." +
      "\n\nACCOUNT FLOWS (sign-up & login): credentials live in the Test accounts vault — list_test_accounts shows site/label/email/username, never passwords. LOGGING IN: inspect the login form, fill the email/username field with {{account:email:<site>}} or {{account:username:<site>}} and the password field with {{account:password:<site>}}, submit, then VERIFY you are logged in (account name/avatar visible, dashboard URL, 'logout' link) before continuing. SIGNING UP: if no account exists for the site, call generate_test_identity first (it creates + stores one), then fill the sign-up form with that identity's tokens (email/username/password) plus any other required fields with sensible test data; after submitting, verify the welcome/confirmation state, and try logging in with the same stored account when the flow allows. NEVER ask the user to paste a password into chat, and never invent a password for an existing account." +
      "\n\nWEB TASKS (do things, not just test): when the user asks you to DO something on a website — register an account, complete a multi-step flow, configure a dashboard, fill an application — work like a careful human operator: restate the goal and the proof you'll look for at the end; plan; execute with py_browser (inspect first, credential tokens for logins, run_site_test-style verification as you go); post brief progress notes at major steps with screenshots at key states; and finish by verifying the end state from evidence and reporting exactly what was done, including which account (email/username) was used." +
      "\n\nHARD STOPS — stop and report for the user to take over when you hit: a CAPTCHA or bot check, an email/SMS verification code you cannot read, a payment or anything that spends real money, or a step that changes something irreversible outside the task (deleting an account, sending email/messages to real people). Everything else, push through and verify.";
  }

  systemPrompt +=
    "\n\nWebsite builder: you can build frontend-only Next.js websites. Workflow: create_site (seeds a fixed scaffold — Next.js App Router, JavaScript/JSX, Tailwind) → write a real app/page.jsx plus any components with write_site_file (pages in app/, custom components in components/, mock data in lib/; NO API routes, server actions or databases — frontend only) → deploy_site with target=preview and share the preview URL. Edit by rewriting files and deploying preview again. Only deploy target=production when the user explicitly says publish / go live — that publishes to https://<slug>." +
    SITE_APEX +
    ". Never try to write package.json, config files, app/layout.jsx, app/globals.css or lib/utils.js; the scaffold owns them. Refer to sites by slug." +
    "\n\nUI RULE for websites: build every interface from the PREINSTALLED shadcn/ui component library — import { Button } from \"@/components/ui/button\", and Card, Badge, Input, Textarea, Label, Accordion, Tabs, Dialog, Separator, Avatar from \"@/components/ui/…\". Use Lucide icons (import { ArrowRight, Star, Check } from \"lucide-react\") — never inline SVG icons. Do NOT hand-roll buttons, inputs, cards or modals with raw divs; compose library components, pass variant/size props, and style with Tailwind classes and theme tokens (bg-primary, text-primary-foreground, bg-card, text-muted-foreground, border-border, bg-muted, bg-accent). Use cn() from \"@/lib/utils\" for conditional classes. Put custom sections in components/ (components/ui/ is the library — never write there)." +
    "\n\nWebsite BACKEND (forms): any form that must SAVE data — contact, order, booking, quote, signup — must use the prebuilt LeadForm from \"@/components/site/lead-form\" (pass form name + fields array) or its submitForm(formName, data) helper for custom layouts. Submissions are stored in the site's inbox automatically; NEVER write a fake onSubmit that only shows a success message. Read submissions any time with the list_site_submissions tool and summarize them for the user (e.g. new orders on the bakery site)." +
    "\n\nLive preview (no Vercel needed): preview_site builds the site inside an E2B sandbox, smoke-tests it, and returns a public preview URL (valid ~10 minutes) the user can open immediately — use it whenever the user wants to SEE or TEST a site before any Vercel deploy, and after edits (each call rebuilds fresh). If the build fails, the tool returns the build log — fix the errors and preview again. After a successful preview, verify it visually with browse_page on the preview URL (screenshot) and report what the page looks like." +
    "\n\nScheduled tasks: when the user asks for something recurring (daily briefings, periodic checks, reminders with research), use create_task with complete self-contained instructions — the future run has no memory of this chat beyond long-term memory. Confirm the schedule back to the user in plain words.";

  const DEFAULT_MODEL: Record<KeyProvider, string> = {
    groq: "openai/gpt-oss-120b",
    gemini: "gemini-2.5-flash",
    lovable: "google/gemini-3-flash-preview",
  };
  // Lovable gateway model ids look like "google/gemini-3-flash-preview".
  const primary: KeyProvider = modelId.startsWith("gemini-")
    ? "gemini"
    : modelId.startsWith("google/")
      ? "lovable"
      : "groq";
  // Try the selected provider first, then automatically fall back to the others.
  const providers: KeyProvider[] = [
    primary,
    ...(["groq", "gemini", "lovable"] as KeyProvider[]).filter((p) => p !== primary),
  ];

  let lastError: unknown = null;

  for (const provider of providers) {
    const mid = provider === primary ? modelId : DEFAULT_MODEL[provider];
    const candidates = await listCandidateKeys(provider);
    if (candidates.length === 0) continue;

    for (const keyRow of candidates) {
      const apiKey = decryptRowKey(keyRow);
      const ai =
        provider === "groq"
          ? createGroq({ apiKey })
          : provider === "gemini"
            ? createGoogleGenerativeAI({ apiKey })
            : createOpenAI({
                baseURL: "https://ai.gateway.lovable.dev/v1",
                apiKey: "lovable-gateway", // placeholder; real auth is the header below, Bearer is stripped
                headers: { "Lovable-API-Key": apiKey },
                fetch: lovableFetch,
              });

    // Browser tool results → model input. Gemini gets the actual screenshot
    // image (it can aim clicks) from the server-side screenshot cache;
    // other providers get text + the knowledge that the user sees the
    // screenshot in chat. The tool output itself carries no base64.
    const browseModelOutput = ({ output }: any) => {
      const o: any = output || {};
      const { screenshotId, ...rest } = o;
      const parts: any[] = [
        { type: "text", text: o.text ? String(o.text) : JSON.stringify(rest) },
      ];
      const cached = screenshotId ? getCachedScreenshot(screenshotId) : undefined;
      if (cached && provider === "gemini") {
        parts.push({ type: "file", data: cached, mediaType: "image/png" });
      } else if (o.screenshotPath) {
        parts.push({
          type: "text",
          text: "A screenshot of the current page state was taken and is displayed to the user in the chat.",
        });
      }
      return { type: "content" as const, value: parts };
    };

    const tools: Record<string, any> = {
      get_current_time: tool({
        description: "Get the current date and time",
        inputSchema: z.object({}),
        execute: async () => new Date().toString(),
      }),
      call_connector: tool({
        description:
          "Call a saved API connector (configured in Settings & keys). The API key is injected server-side — never ask the user for it. " +
          "Returns { ok, status, body, truncated } where body is compact valid JSON (complete items only). " +
          "For list endpoints pass query { per_page: '20' } to keep responses small. " +
          "Never call the same endpoint twice with identical parameters — use the first result. " +
          "After the tool returns, always summarize the data for the user in chat.",
        inputSchema: z.object({
          connector: z.string().describe("Connector name exactly as shown in Settings"),
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
          path: z.string().describe("API path starting with /, appended to the connector base URL"),
          query: z.record(z.string(), z.string()).optional().describe("Query parameters"),
          body: z.any().optional().describe("JSON body for POST/PUT/PATCH"),
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
        description:
          "Save a durable fact about the user (name, preferences, projects, people, decisions) to long-term memory so you remember it in future conversations. Use whenever the user shares something worth remembering. Never save passwords or API keys.",
        inputSchema: z.object({
          fact: z.string().describe("The fact to remember, one clear sentence"),
        }),
        execute: async ({ fact }) => {
          const stored = await addMemory(fact);
          return { ok: true, stored, note: stored ? "Saved to long-term memory." : "Already remembered." };
        },
      }),
      read_url: tool({
        description:
          "Fetch a public web page or URL and read its text content. Use when the user shares a link or asks what a page says.",
        inputSchema: z.object({
          url: z.string().describe("Full http(s) URL"),
        }),
        execute: async ({ url }) => {
          try {
            const r = await fetchPublicText(url);
            return { ok: r.ok, status: r.status, text: r.text, truncated: r.truncated };
          } catch (e: any) {
            return { ok: false, status: 0, text: `Read failed: ${e?.message || e}`, truncated: false };
          }
        },
      }),
      create_file: tool({
        description:
          "Create a downloadable text file (markdown, csv, json, html, txt, code) for the user. Returns a download path — include it in your reply as a markdown link like [Download name](path).",
        inputSchema: z.object({
          name: z.string().describe("File name with extension, e.g. report.md"),
          content: z.string().describe("Full file content"),
        }),
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
        description:
          "Create a new frontend-only Next.js website (fixed scaffold: App Router, JavaScript/JSX, Tailwind, shadcn/ui component library + Lucide icons preinstalled). The slug becomes its subdomain <slug>." +
          SITE_APEX +
          ". After creating, write a real app/page.jsx (and components) with write_site_file, composing @/components/ui components and lucide-react icons, then deploy a preview.",
        inputSchema: z.object({
          name: z.string().describe("Site name, e.g. 'Al Khair Bakery'"),
          slug: z
            .string()
            .optional()
            .describe("Subdomain slug (lowercase, hyphens). Defaults to a slugified name."),
        }),
        execute: async ({ name, slug }) => {
          try {
            const { site, fileCount } = await createSite(name, slug);
            return {
              ok: true,
              site: site.slug,
              name: site.name,
              liveUrl: `https://${site.slug}.${SITE_APEX}`,
              scaffoldFiles: fileCount,
              note: "Scaffold ready. Now write the real pages with write_site_file, then deploy_site target=preview.",
            };
          } catch (e: any) {
            return { ok: false, error: e?.message || "Could not create site" };
          }
        },
      }),
      write_site_file: tool({
        description:
          "Create or overwrite one file of a website (by slug). Pages: app/page.jsx, app/<route>/page.jsx. Custom components: components/*.jsx (NOT components/ui/ — that's the preinstalled shadcn/ui library: button, badge, card, input, textarea, label, accordion, tabs, dialog, separator, avatar; import and compose those). Mock data: lib/*.js. Frontend only: no API routes or server code.",
        inputSchema: z.object({
          site: z.string().describe("Site slug"),
          path: z.string().describe("e.g. app/page.jsx"),
          content: z.string().describe("Full file content"),
        }),
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
        description: "List all files of a website (by slug) with sizes.",
        inputSchema: z.object({ site: z.string() }),
        execute: async ({ site }) => {
          try {
            const s = await resolveSite(site);
            if (!s) return { ok: false, error: `Site "${site}" not found` };
            const files = await listSiteFiles(s.id);
            return { ok: true, site: s.slug, files };
          } catch (e: any) {
            return { ok: false, error: e?.message || "Could not list files" };
          }
        },
      }),
      read_site_file: tool({
        description: "Read one file of a website (by slug) — use before editing it.",
        inputSchema: z.object({ site: z.string(), path: z.string() }),
        execute: async ({ site, path }) => {
          try {
            const s = await resolveSite(site);
            if (!s) return { ok: false, error: `Site "${site}" not found` };
            const content = await readSiteFile(s.id, path);
            if (content === null) return { ok: false, error: `No file ${path} in site ${s.slug}` };
            return { ok: true, site: s.slug, path, content: content.slice(0, 12000) };
          } catch (e: any) {
            return { ok: false, error: e?.message || "Could not read file" };
          }
        },
      }),
      deploy_site: tool({
        description:
          "Deploy a website (by slug) to Vercel. target=preview returns a live preview URL to share. target=production publishes it to https://<slug>." +
          SITE_APEX +
          " — only when the user explicitly says publish/go live. Builds can take 1–4 minutes.",
        inputSchema: z.object({
          site: z.string().describe("Site slug"),
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
      site_status: tool({
        description: "Get a website's status: name, slug, preview URL, live URL, file count.",
        inputSchema: z.object({ site: z.string() }),
        execute: async ({ site }) => {
          try {
            const s = await resolveSite(site);
            if (!s) return { ok: false, error: `Site "${site}" not found` };
            const files = await listSiteFiles(s.id);
            return {
              ok: true,
              name: s.name,
              slug: s.slug,
              status: s.status,
              previewUrl: s.preview_url,
              liveUrl: s.live_url,
              fileCount: files.length,
              updatedAt: s.updated_at,
            };
          } catch (e: any) {
            return { ok: false, error: e?.message || "Could not read site" };
          }
        },
      }),
      preview_site: tool({
        description:
          "Build and serve a website (by slug) in an E2B sandbox and return a public LIVE PREVIEW URL (valid ~10 min) — no Vercel deploy needed. The sandbox build doubles as a test: on failure you get the build log to fix. After success, screenshot the URL with browse_page to verify it visually.",
        inputSchema: z.object({ site: z.string().describe("Site slug") }),
        execute: async ({ site }) => {
          const r = await startSitePreview(site);
          return { ...r, previewUrl: r.url };
        },
      }),
      stop_preview: tool({
        description: "Stop a website's live preview sandbox (by slug).",
        inputSchema: z.object({ site: z.string().describe("Site slug") }),
        execute: async ({ site }) => {
          const s = await resolveSite(site);
          if (!s) return { ok: false, error: `Site "${site}" not found` };
          return stopSitePreview(s.id);
        },
      }),
      list_site_submissions: tool({
        description:
          "Read a website's form submissions inbox (by slug): contact messages, orders, bookings sent from the site's LeadForm/submitForm forms. Use when the user asks about messages/orders from a site, and in digests.",
        inputSchema: z.object({
          site: z.string().describe("Site slug"),
          limit: z.number().optional().describe("Max rows (default 20)"),
          unreadOnly: z.boolean().optional().describe("Only unread submissions"),
        }),
        execute: async ({ site, limit, unreadOnly }) => {
          try {
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
          } catch (e: any) {
            return { ok: false, error: e?.message || "Could not read submissions" };
          }
        },
      }),
      create_task: tool({
        description:
          "Create a scheduled autonomous task: the agent runs the instructions on a schedule with its full toolset and posts the report into a dedicated chat. Schedules: daily or weekly at time_of_day (HH:MM, 24h) in a timezone (default Asia/Karachi), or interval every interval_minutes (min 15). Use when the user asks for something recurring ('every morning…', 'daily', 'each Monday…').",
        inputSchema: z.object({
          name: z.string().describe("Short task name"),
          instructions: z
            .string()
            .describe("Complete, self-contained instructions for the future run — no chat context will exist then"),
          schedule_kind: z.enum(["daily", "weekly", "interval"]),
          time_of_day: z.string().optional().describe("HH:MM 24h, for daily/weekly"),
          weekday: z.number().min(0).max(6).optional().describe("For weekly: 0=Sunday … 6=Saturday"),
          interval_minutes: z.number().optional().describe("For interval schedules (min 15)"),
          timezone: z.string().optional().describe("IANA timezone, default Asia/Karachi"),
        }),
        execute: async (input) => {
          try {
            const t = await createTask({ ...input, timezone: input.timezone || "Asia/Karachi" });
            return {
              ok: true,
              id: t.id,
              name: t.name,
              schedule: describeSchedule(t),
              nextRun: t.next_run_at,
              note: "Reports will appear in a chat named ⏰ " + t.name + " and on the Tasks page.",
            };
          } catch (e: any) {
            return { ok: false, error: e?.message || "Could not create task" };
          }
        },
      }),
      list_tasks: tool({
        description: "List the user's scheduled autonomous tasks with schedules, next run and last status.",
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
              lastRun: t.last_run_at,
              nextRun: t.next_run_at,
            })),
          };
        },
      }),
      ...(e2bKey
        ? {
            run_code: tool({
              description:
                "Run Python or JavaScript in a secure E2B cloud sandbox (never on the server). Use for calculations, data processing, chart data, or testing snippets. Returns stdout, stderr, results and errors.",
              inputSchema: z.object({
                language: z.enum(["python", "javascript"]).default("python"),
                code: z.string().describe("The code to execute"),
              }),
              execute: async ({ code, language }) => {
                try {
                  const r = await runCode(e2bKey, code, language);
                  return { ok: !r.error, stdout: r.stdout, stderr: r.stderr, results: r.results, error: r.error };
                } catch (e: any) {
                  return { ok: false, error: `Sandbox error: ${e?.message || e}` };
                }
              },
            }),
          }
        : {}),
      ...(e2bKey
        ? {
            browse_page: tool({
              description:
                "Render a web page in a real Chrome browser (JavaScript fully executed — use when read_url returns empty/blocked content or the page is an app/dashboard) and extract its readable text. Optionally capture a screenshot, shown to the user.",
              inputSchema: z.object({
                url: z.string().describe("Full http(s) URL"),
                screenshot: z
                  .boolean()
                  .default(false)
                  .describe("Also capture a screenshot of the rendered page"),
              }),
              execute: async ({ url, screenshot }) => {
                try {
                  return await browsePage(e2bKey, conversationId, url, screenshot);
                } catch (e: any) {
                  return { ok: false, error: `Browse failed: ${e?.message || e}` };
                }
              },
              toModelOutput: browseModelOutput,
            }),
            browser_open: tool({
              description:
                "Open a page in the interactive cloud browser (a live desktop with Chrome). Starts a session kept across calls in this conversation. Returns a screenshot (shown to the user, and to you on vision providers), the window title, screen size, and a Watch-live link for the user.",
              inputSchema: z.object({
                url: z.string().describe("Full http(s) URL to open"),
              }),
              execute: async ({ url }) => {
                try {
                  return await browserOpen(e2bKey, conversationId, url);
                } catch (e: any) {
                  return { ok: false, error: `Browser failed: ${e?.message || e}` };
                }
              },
              toModelOutput: browseModelOutput,
            }),
            browser_act: tool({
              description:
                "Perform one action in the interactive browser session and get a fresh screenshot: navigate (go to a URL), click (pixel x,y on the screenshot), type (text at the focused element — click a field first), press (a key or combo like 'enter', 'ctrl+l', 'tab', 'pagedown'), scroll, or screenshot (just look again).",
              inputSchema: z.object({
                action: z.enum(["navigate", "click", "type", "press", "scroll", "screenshot"]),
                url: z.string().optional().describe("For navigate: the full http(s) URL"),
                x: z.number().optional().describe("For click: horizontal pixel"),
                y: z.number().optional().describe("For click: vertical pixel"),
                text: z.string().optional().describe("For type: the text to type"),
                key: z
                  .string()
                  .optional()
                  .describe("For press: e.g. 'enter', 'escape', 'tab', 'ctrl+l', 'ctrl+a'"),
                direction: z.enum(["up", "down"]).optional().describe("For scroll"),
              }),
              execute: async ({ action, url, x, y, text, key, direction }) => {
                try {
                  return await browserAct(e2bKey, conversationId, action, {
                    url,
                    x,
                    y,
                    text,
                    key,
                    direction,
                  });
                } catch (e: any) {
                  return { ok: false, error: `Browser action failed: ${e?.message || e}` };
                }
              },
              toModelOutput: browseModelOutput,
            }),
            browser_close: tool({
              description:
                "Close the interactive browser session and free the sandbox. Use when the browsing task is finished.",
              inputSchema: z.object({}),
              execute: async () => browserClose(conversationId),
            }),
            py_browser: tool({
              description:
                "Python (Playwright) browser automation — PREFER this for FORM FILLING and precise interaction: it drives the page by DOM selectors, not pixels. Actions: open (go to URL, returns page text + screenshot), inspect (map the page's forms, fields, buttons and their correct selectors — ALWAYS inspect before filling a form you haven't seen), fill (selector + value; returns the field's actual value as read-back proof), type, click (selector; waits for the page to settle and returns the resulting page text), submit (form selector, or Enter when omitted), press (key), scroll (direction/amount, or to a selector), wait_for (until a selector is visible / page contains text / URL contains a string), read (page text), screenshot, close. Selectors: CSS (#id, [name='email'], button[type='submit'], .class) or Playwright text engine (text=Sign in). CREDENTIALS: never type a real password yourself — for a stored test account, set the fill value to a token {{account:email:<site-or-id>}}, {{account:username:<site-or-id>}} or {{account:password:<site-or-id>}} and the server substitutes the secret inside the browser (the read-back comes back masked). The session persists across calls in this conversation.",
              inputSchema: z.object({
                action: z.enum(["open", "inspect", "fill", "type", "click", "submit", "press", "scroll", "wait_for", "read", "screenshot", "close"]),
                url: z.string().optional().describe("For open: full http(s) URL"),
                selector: z.string().optional().describe("CSS or text= selector for fill/type/click/submit/scroll/wait_for"),
                value: z.string().optional().describe("For fill/type: the text to enter"),
                key: z.string().optional().describe("For press: e.g. Enter, Tab, Escape, ArrowDown"),
                direction: z.enum(["up", "down"]).optional().describe("For scroll"),
                amount: z.number().optional().describe("For scroll: pixels (default 600)"),
                text: z.string().optional().describe("For wait_for: text that must appear on the page"),
                urlContains: z.string().optional().describe("For wait_for: substring the URL must contain"),
                ms: z.number().optional().describe("For wait_for: timeout in ms (default 10000)"),
                screenshot: z.boolean().optional().describe("Force a screenshot with this action"),
              }),
              execute: async (args) => {
                try {
                  return await pyBrowserAction(e2bKey, conversationId, args.action, args);
                } catch (e: any) {
                  return { ok: false, error: `Python browser failed: ${e?.message || e}` };
                }
              },
              toModelOutput: browseModelOutput,
            }),
            list_test_accounts: tool({
              description:
                "List the test accounts in the vault (site, label, email, username — passwords are NEVER shown). Use to find the right account before a login, and to refer to an account when filling credential fields with tokens.",
              inputSchema: z.object({}),
              execute: async () => {
                try {
                  return { ok: true, accounts: await listTestAccounts() };
                } catch (e: any) {
                  return { ok: false, error: e?.message || "Could not list accounts" };
                }
              },
            }),
            generate_test_identity: tool({
              description:
                "Create and store a fresh test identity for a site (for SIGN-UP flows): generates a name, username, email and a strong password, and saves them in the Test accounts vault. Returns the email/username (never the password). Afterwards, sign up by filling the form fields with the credential tokens for this site, and the same stored account works for later logins.",
              inputSchema: z.object({
                site: z.string().describe("Site URL or domain the identity is for"),
                label: z.string().optional(),
              }),
              execute: async ({ site, label }) => {
                try {
                  const account = await generateTestIdentity(site, label);
                  return { ok: true, account, note: "Identity stored. Fill its fields with {{account:email:" + site + "}}, {{account:username:" + site + "}} and {{account:password:" + site + "}} tokens." };
                } catch (e: any) {
                  return { ok: false, error: e?.message || "Could not generate identity" };
                }
              },
            }),
            run_site_test: tool({
              description:
                "Run a PLANNED site test in the py_browser session: give an ordered list of steps, each with an optional expectation (expect.textContains / urlContains / titleContains / valueEquals). Steps execute in order; every expectation is checked against what was actually observed; the run stops at the first failure and returns a structured report (per-step observed URL/title/value, failure reasons, and a screenshot of the failure state). Use this for form flows and site QA instead of ad-hoc clicking: inspect the page first to get real selectors, then encode the test. After a failure, diagnose from the report + screenshot, fix ONE thing, and re-run.",
              inputSchema: z.object({
                steps: z.array(
                  z.object({
                    action: z.enum(["open", "inspect", "fill", "type", "click", "submit", "press", "scroll", "wait_for", "read", "screenshot"]),
                    url: z.string().optional(),
                    selector: z.string().optional(),
                    value: z.string().optional(),
                    key: z.string().optional(),
                    direction: z.enum(["up", "down"]).optional(),
                    amount: z.number().optional(),
                    note: z.string().optional().describe("What this step is meant to prove"),
                    expect: z
                      .object({
                        textContains: z.string().optional(),
                        urlContains: z.string().optional(),
                        titleContains: z.string().optional(),
                        valueEquals: z.string().optional(),
                      })
                      .optional(),
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
              toModelOutput: browseModelOutput,
            }),
            api_test: tool({
              description:
                "Test HTTP APIs with Python requests and get structured results + assertion checks. Single call: method, url, optional headers/body, expectations (expectStatus, bodyContains, jsonPath like data.0.id, jsonEquals). MULTI-STEP flows: pass `steps` (array of the same fields) — steps run in order in one session; a step may extract values from its JSON response with extract: {varName: 'json.dot.path'} and later steps use {{varName}} in url/headers/body (e.g. login → extract token → call a protected endpoint with Authorization: Bearer {{token}}). Returns per-step status, time, checks and extracted variable names.",
              inputSchema: z.object({
                method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
                url: z.string().optional().describe("Full http(s) URL (single-call mode; not needed when steps are given)"),
                headers: z.record(z.string(), z.string()).optional(),
                body: z.any().optional().describe("JSON body (object/array) or raw string"),
                expectStatus: z.number().optional(),
                bodyContains: z.string().optional(),
                jsonPath: z.string().optional().describe("Dot path into the JSON response, e.g. data.items.0.name"),
                jsonEquals: z.any().optional().describe("Expected value at jsonPath"),
                steps: z
                  .array(
                    z.object({
                      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
                      url: z.string(),
                      headers: z.record(z.string(), z.string()).optional(),
                      body: z.any().optional(),
                      expectStatus: z.number().optional(),
                      bodyContains: z.string().optional(),
                      jsonPath: z.string().optional(),
                      jsonEquals: z.any().optional(),
                      extract: z.record(z.string(), z.string()).optional().describe("Map of variable name -> JSON dot path to extract from this step's response"),
                    })
                  )
                  .optional()
                  .describe("Multi-step flow; when present, the top-level fields are ignored"),
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
            }),
          }
        : {}),
      show_guide: tool({
        description:
          "Display a visual structured guide/diagram to the user: a title plus cards connected by flow arrows, optionally side-by-side in a row. Each card has an icon name, title, optional badge, short lines and an optional muted footnote. Use for architectures, processes, comparisons and step-by-step overviews instead of long plain-text lists. After calling it, add only a brief text summary.",
        inputSchema: z.object({
          title: z.string().describe("Guide heading, e.g. 'Architecture overview'"),
          blocks: z
            .array(
              z.object({
                kind: z.enum(["card", "row"]),
                icon: z
                  .string()
                  .optional()
                  .describe("For kind=card — one of: github, monitor, server, database, globe, shield, zap, layers, box, cloud, phone, code, chart, wallet, bot, key, mail, bell"),
                title: z.string().optional(),
                badge: z.string().optional(),
                badgeTone: z.enum(["green", "violet", "gray", "red", "amber"]).optional(),
                lines: z.array(z.string()).max(5).optional(),
                muted: z.string().optional().describe("Small muted footnote line"),
                cards: z
                  .array(
                    z.object({
                      icon: z.string().optional(),
                      title: z.string(),
                      badge: z.string().optional(),
                      badgeTone: z.enum(["green", "violet", "gray", "red", "amber"]).optional(),
                      lines: z.array(z.string()).max(5).optional(),
                      muted: z.string().optional(),
                    })
                  )
                  .max(3)
                  .optional()
                  .describe("For kind=row: 2–3 cards side by side"),
              })
            )
            .min(1)
            .max(8),
        }),
        execute: async () => ({
          ok: true,
          note: "Guide displayed to the user. Now give a brief text summary only — do not repeat the guide content.",
        }),
      }),
    };
    // Web search per provider: Groq browser search / Google search grounding.
    // Guarded: if the provider build doesn't expose it, chat simply has no web search.
    try {
      if (provider === "groq") {
        const maybeSearch = (ai as any)?.tools?.browserSearch;
        if (typeof maybeSearch === "function") tools.web_search = maybeSearch({});
      } else {
        const maybeSearch = (google as any)?.tools?.googleSearch;
        if (typeof maybeSearch === "function") tools.web_search = maybeSearch({});
      }
    } catch {
      /* web search unavailable */
    }

    try {
      const result = streamText({
        // Lovable gateway: Gemini models only work on /v1/chat/completions,
        // so force the chat model (the SDK default is the Responses API).
        model: provider === "lovable" ? (ai as any).chat(mid) : ai(mid),
        system: systemPrompt,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(10),
        onFinish: async ({ text }) => {
          await markKeyUsed(keyRow.id, provider);
          if (conversationId) await persistTurn(conversationId, messages, text);
        },
        onError: async ({ error }) => {
          // Mark the key's state for the NEXT request (can't swap mid-stream).
          const { status, retryAfter } = errorInfo(error);
          try {
            if (status === 429) await cooldownKey(keyRow.id, retryAfter ?? 60, provider);
            else if (status === 401) await disableKey(keyRow.id, provider);
          } catch {}
        },
      });
      return result.toUIMessageStreamResponse({
        // Replaces the SDK's default "An error occurred." with something useful.
        onError: (error) => {
          console.error("chat stream error", error);
          return streamErrorMessage(error);
        },
      });
    } catch (err) {
      // Synchronous failure before streaming (bad key etc.) — try next key.
      lastError = err;
      const { status, retryAfter } = errorInfo(err);
      if (status === 429) {
        await cooldownKey(keyRow.id, retryAfter ?? 60, provider);
        continue;
      }
      if (status === 401) {
        await disableKey(keyRow.id, provider);
        continue;
      }
      break;
    }
    }
  }

  console.error("All Groq, Gemini and Lovable keys failed", lastError);
  return NextResponse.json({ error: "All Groq, Gemini and Lovable keys failed. Check Settings → Keys." }, { status: 502 });
}
