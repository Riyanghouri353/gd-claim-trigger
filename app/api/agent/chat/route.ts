import { streamText, convertToModelMessages, stepCountIs, tool } from "ai";
import { createGroq } from "@ai-sdk/groq";
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
} from "@/lib/agent/keys";

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
    return new Response("Unauthorized", { status: 401 });
  }

  const { messages, conversationId } = await req.json();
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response("No messages", { status: 400 });
  }

  const modelMessages = await convertToModelMessages(messages);
  const modelId = (await getSetting("chat_model")) || "openai/gpt-oss-120b";
  const systemPrompt =
    (await getSetting("system_prompt")) ||
    "You are Riyan's personal AI assistant: warm, direct, technically sharp. Answer concisely, use code blocks for code, and use tools when they help.";

  const candidates = await listCandidateKeys();
  if (candidates.length === 0) {
    return new Response("No active Groq keys. Add one in Settings.", { status: 503 });
  }

  let lastError: unknown = null;

  for (const keyRow of candidates) {
    const apiKey = decryptRowKey(keyRow);
    const groq = createGroq({ apiKey });

    const tools: Record<string, any> = {
      get_current_time: tool({
        description: "Get the current date and time",
        inputSchema: z.object({}),
        execute: async () => new Date().toString(),
      }),
    };
    // Groq's free browser-search tool (gpt-oss models). Guarded: if the
    // provider build doesn't expose it, the agent simply has no web search.
    try {
      const maybeSearch = (groq as any)?.tools?.browserSearch;
      if (typeof maybeSearch === "function") tools.web_search = maybeSearch({});
    } catch {
      /* web search unavailable */
    }

    try {
      const result = streamText({
        model: groq(modelId),
        system: systemPrompt,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(6),
        onFinish: async ({ text }) => {
          await markKeyUsed(keyRow.id);
          if (conversationId) await persistTurn(conversationId, messages, text);
        },
        onError: async ({ error }) => {
          // Mark the key's state for the NEXT request (can't swap mid-stream).
          const { status, retryAfter } = errorInfo(error);
          try {
            if (status === 429) await cooldownKey(keyRow.id, retryAfter ?? 60);
            else if (status === 401) await disableKey(keyRow.id);
          } catch {}
        },
      });
      return result.toUIMessageStreamResponse();
    } catch (err) {
      // Synchronous failure before streaming (bad key etc.) — try next key.
      lastError = err;
      const { status, retryAfter } = errorInfo(err);
      if (status === 429) {
        await cooldownKey(keyRow.id, retryAfter ?? 60);
        continue;
      }
      if (status === 401) {
        await disableKey(keyRow.id);
        continue;
      }
      break;
    }
  }

  console.error("All Groq keys failed", lastError);
  return new Response("All Groq keys failed. Check Settings → Keys.", { status: 502 });
}
