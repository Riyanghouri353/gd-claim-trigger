import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { listCandidateKeys, decryptRowKey, markKeyUsed } from "@/lib/agent/keys";

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

/** Look up a service's API connection details via the agent's Groq keys. */
export async function POST(req: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { service } = await req.json();
  const s = String(service || "").trim().slice(0, 80);
  if (!s) return NextResponse.json({ error: "Service name required" }, { status: 400 });

  const keys = await listCandidateKeys();
  if (keys.length === 0) {
    return NextResponse.json(
      { error: "Add a Groq API key first — discovery uses your key pool" },
      { status: 503 }
    );
  }

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${decryptRowKey(keys[0])}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: s },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 400,
      }),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Discovery failed (Groq HTTP ${res.status})` },
        { status: 502 }
      );
    }
    const j = await res.json();
    const raw = j.choices?.[0]?.message?.content || "{}";
    const p = JSON.parse(raw);
    await markKeyUsed(keys[0].id).catch(() => {});

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
    return NextResponse.json({ error: e?.message || "Discovery failed" }, { status: 500 });
  }
}
