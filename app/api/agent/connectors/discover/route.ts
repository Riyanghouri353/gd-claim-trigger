import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import {
  listCandidateKeys,
  decryptRowKey,
  markKeyUsed,
  cooldownKey,
  disableKey,
  getSetting,
  type KeyProvider,
} from "@/lib/agent/keys";

export const dynamic = "force-dynamic";

const SYSTEM = `You are an API directory. Given a service/product name, return its public REST API connection details as a single JSON object and nothing else:
{"baseUrl":"https://...","authType":"bearer|header|query|basic|none","authField":"...","testPath":"/...","keyHint":"...","confidence":"high|medium|low"}
Rules:
- baseUrl: the API root over https, no trailing slash, no path placeholders.
- authType: "bearer" = Authorization: Bearer <key>; "header" = custom header named in authField; "query" = key sent as query param named in authField; "basic" = username in authField + key as password; "none" = no auth needed.
- authField: header name for "header" (e.g. "X-API-Key"), param name for "query" (e.g. "api_key"), username label for "basic", empty string otherwise.
- testPath: a cheap, safe GET endpoint that validates a key (e.g. "/v1/models"). Empty string if none known.
- keyHint: one short line telling the user where to create/find the key (e.g. "Dashboard → API Keys → Create").
- confidence: "high" if you are sure, "medium" if likely, "low" if guessing. Never invent a baseUrl — use "low" when unsure.`;

const AUTH_TYPES = ["bearer", "header", "query", "basic", "none"];

class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** Ask an OpenAI-compatible chat endpoint; returns the raw message content. */
async function askCompatible(
  url: string,
  headers: Record<string, string>,
  model: string,
  service: string,
  jsonMode: boolean
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: service },
      ],
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      temperature: 0,
      max_tokens: 500,
    }),
  });
  if (!res.ok) throw new HttpError(res.status);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || "{}";
}

/** Ask Gemini via its native API; returns the raw text. */
async function askGemini(key: string, model: string, service: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ parts: [{ text: service }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 500,
          responseMimeType: "application/json",
        },
      }),
    }
  );
  if (!res.ok) throw new HttpError(res.status);
  const j = await res.json();
  return j.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "{}";
}

function ask(provider: KeyProvider, key: string, service: string): Promise<string> {
  if (provider === "groq") {
    return askCompatible(
      "https://api.groq.com/openai/v1/chat/completions",
      { Authorization: ["Bearer", key].join(" ") },
      "openai/gpt-oss-20b",
      service,
      true
    );
  }
  if (provider === "lovable") {
    return askCompatible(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      { "Lovable-API-Key": key },
      "google/gemini-3-flash-preview",
      service,
      false
    );
  }
  return askGemini(key, "gemini-2.5-flash", service);
}

/** Extract and parse the first JSON object from model output. */
function parseJsonObject(raw: string): any {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("Model did not return JSON");
  }
}

/**
 * Look up a service's API connection details using ANY available key:
 * providers in the chat's order (selected model's provider first), and
 * EVERY candidate key in each pool until one returns parseable JSON.
 * A dead key never blocks discovery — it is disabled/cooled down and the
 * next key is tried. Not limited to a single key or a single provider.
 */
export async function POST(req: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { service } = await req.json();
  const s = String(service || "").trim().slice(0, 80);
  if (!s) return NextResponse.json({ error: "Service name required" }, { status: 400 });

  const modelId = (await getSetting("chat_model").catch(() => null)) || "";
  const primary: KeyProvider = modelId.startsWith("gemini-")
    ? "gemini"
    : modelId.startsWith("google/")
      ? "lovable"
      : "groq";
  const providers: KeyProvider[] = [
    primary,
    ...(["groq", "gemini", "lovable"] as KeyProvider[]).filter((p) => p !== primary),
  ];

  let lastError = "";
  let anyKeys = false;

  for (const provider of providers) {
    const keys = await listCandidateKeys(provider).catch(() => []);
    for (const keyRow of keys) {
      anyKeys = true;
      try {
        const raw = await ask(provider, decryptRowKey(keyRow), s);
        const p = parseJsonObject(raw);
        await markKeyUsed(keyRow.id, provider).catch(() => {});

        // Sanitize: never trust model output blindly.
        let baseUrl = "";
        try {
          const u = new URL(String(p.baseUrl || ""));
          if (u.protocol === "https:") baseUrl = u.toString().replace(/\/+$/, "");
        } catch { /* leave empty */ }
        const authType = AUTH_TYPES.includes(p.authType) ? p.authType : "bearer";
        return NextResponse.json({
          ok: true,
          baseUrl,
          authType,
          authField: String(p.authField || "").slice(0, 60),
          testPath: String(p.testPath || "").slice(0, 120),
          keyHint: String(p.keyHint || "").slice(0, 200),
          confidence: ["high", "medium", "low"].includes(p.confidence) ? p.confidence : "low",
          provider,
        });
      } catch (e: any) {
        lastError = e?.message || "failed";
        if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
          await disableKey(keyRow.id, provider).catch(() => {});
        } else if (e instanceof HttpError && e.status === 429) {
          await cooldownKey(keyRow.id, 120, provider).catch(() => {});
        }
        // fall through to the next key / provider
      }
    }
  }

  if (!anyKeys) {
    return NextResponse.json(
      { error: "Add an API key first (Groq, Gemini or Lovable) — discovery uses whichever keys you have" },
      { status: 503 }
    );
  }
  return NextResponse.json(
    { error: `Discovery failed (${lastError || "no provider responded"})` },
    { status: 502 }
  );
}
