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
            const f = await createAgentFile(name, content);
            return { ok: true, name, download: f.path };
          } catch (e: any) {
            return { ok: false, error: e?.message || "Could not create file" };
          }
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
