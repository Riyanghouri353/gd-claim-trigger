import { getServiceClient } from "./supabase";
import { decryptSecret } from "./crypto";

export type KeyProvider = "groq" | "gemini" | "lovable";

const KEY_TABLES: Record<KeyProvider, "groq_keys" | "gemini_keys" | "lovable_keys"> = {
  groq: "groq_keys",
  gemini: "gemini_keys",
  lovable: "lovable_keys",
};

export type GroqKeyRow = {
  id: string;
  label: string;
  enc_key: string;
  iv: string;
  tag: string;
  disabled: boolean;
  cooldown_until: string | null;
  last_used_at: string | null;
  created_at: string;
}

/**
 * Candidate keys for the next request: enabled, not cooling down,
 * ordered least-recently-used first (round-robin).
 */
export async function listCandidateKeys(provider: KeyProvider = "groq"): Promise<GroqKeyRow[]> {
  const sb = getServiceClient();
  const { data, error } = await sb
    .from(KEY_TABLES[provider])
    .select("*")
    .eq("disabled", false)
    .or("cooldown_until.is.null,cooldown_until.lt.now()")
    .order("last_used_at", { ascending: true, nullsFirst: true })
    .limit(10);
  if (error) throw error;
  return (data ?? []) as GroqKeyRow[];
}

export function decryptRowKey(row: GroqKeyRow): string {
  return decryptSecret({ enc: row.enc_key, iv: row.iv, tag: row.tag });
}

export async function markKeyUsed(id: string, provider: KeyProvider = "groq") {
  await getServiceClient()
    .from(KEY_TABLES[provider])
    .update({ last_used_at: new Date().toISOString(), cooldown_until: null })
    .eq("id", id);
}

/** Park a key until `seconds` pass (used on 429 rate limits). */
export async function cooldownKey(id: string, seconds: number, provider: KeyProvider = "groq") {
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  await getServiceClient().from(KEY_TABLES[provider]).update({ cooldown_until: until }).eq("id", id);
}

/** Permanently disable a key (used on 401 invalid key). */
export async function disableKey(id: string, provider: KeyProvider = "groq") {
  await getServiceClient().from(KEY_TABLES[provider]).update({ disabled: true }).eq("id", id);
}

/** Live-test a Lovable AI Gateway key against its OpenAI-compatible endpoint. */
export async function testLovableKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/models", {
      headers: { "Lovable-API-Key": apiKey },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "Invalid key" };
    if (!res.ok) return { ok: false, error: `Lovable gateway returned ${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error reaching Lovable gateway" };
  }
}
/** Live-test a Gemini API key against Google's models endpoint. */
export async function testGeminiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    if (res.status === 400) {
      const j = await res.json().catch(() => null);
      const msg = String(j?.error?.message || "");
      if (/api key not valid|invalid/i.test(msg)) return { ok: false, error: "Invalid key" };
      return { ok: true }; // key exists, other 400 reason
    }
    if (res.status === 403) return { ok: false, error: "Key rejected (403)" };
    if (!res.ok) return { ok: false, error: `Google returned ${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error reaching Google" };
  }
}

export async function getSetting(key: string): Promise<string | null> {
  const { data }: { data: { value: string } | null } = await getServiceClient()
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  const { error } = await getServiceClient().from("app_settings").upsert({ key, value });
  if (error) throw error;
}

export async function isSetupDone(): Promise<boolean> {
  return (await getSetting("password_hash")) !== null;
}
