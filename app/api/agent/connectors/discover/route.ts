import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { listCandidateKeys, decryptRowKey, markKeyUsed, type KeyProvider } from "@/lib/agent/keys";

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

/** Ask an OpenAI-compatible endpoint for the JSON; returns the raw content. */
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
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || "{}";
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
 * Look up a service's API connection details using whichever key pool is
 * available: Groq first, then the Lovable gateway (both OpenAI-compatible).
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

  const attempts: { provider: KeyProvider; run: (key: string) => Promise<string> }[] = [
    {
      provider: "groq",
      run: (key) =>
        askCompatible(
          "https://api.groq.com/openai/v1/chat/completions",
          { Authorization: ["Bearer", key].join(" ") },
          "openai/gpt-oss-20b",
          s,
          true
        ),
    },
    {
      provider: "lovable",
      run: (key) =>
        askCompatible(
          "https://ai.gateway.lovable.dev/v1/chat/completions",
          { "Lovable-API-Key": key },
          "google/gemini-3-flash-preview",
          s,
          false
        ),
    },
  ];

  let lastError = "";
  let anyKeys = false;
  for (const attempt of attempts) {
    const keys = await listCandidateKeys(attempt.provider).catch(() => []);
    if (keys.length === 0) continue;
    anyKeys = true;
    try {
      const raw = await attempt.run(decryptRowKey(keys[0]));
      const p = parseJsonObject(raw);
      await markKeyUsed(keys[0].id, attempt.provider).catch(() => {});

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
      });
    } catch (e: any) {
      lastError = e?.message || "failed";
    }
  }

  if (!anyKeys) {
    return NextResponse.json(
      { error: "Add a Groq or Lovable API key first — discovery uses your key pool" },
      { status: 503 }
    );
  }
  return NextResponse.json(
    { error: `Discovery failed (${lastError || "no provider responded"})` },
    { status: 502 }
  );
}
