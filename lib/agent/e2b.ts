import { getSetting, setSetting } from "./keys";
import { encryptSecret, decryptSecret } from "./crypto";

const SETTING_KEY = "e2b_key_enc";

/** The stored E2B API key (decrypted), or null when not configured. */
export async function getE2BKey(): Promise<string | null> {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return null;
  try {
    const bundle = JSON.parse(raw);
    return decryptSecret(bundle);
  } catch {
    return null;
  }
}

export async function setE2BKey(apiKey: string): Promise<void> {
  const bundle = encryptSecret(apiKey.trim());
  await setSetting(SETTING_KEY, JSON.stringify(bundle));
}

export async function deleteE2BKey(): Promise<void> {
  const { getServiceClient } = await import("./supabase");
  await getServiceClient().from("app_settings").delete().eq("key", SETTING_KEY);
}

/** Validate an E2B key against their API (lists sandboxes). */
export async function testE2BKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.e2b.dev/sandboxes", {
      headers: { "X-API-KEY": apiKey },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "Invalid E2B key" };
    if (!res.ok) return { ok: false, error: `E2B returned ${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error reaching E2B" };
  }
}

export interface CodeRunResult {
  stdout: string;
  stderr: string;
  results: string[];
  error?: string;
}

/** Run code in an E2B cloud sandbox (never on our server). */
export async function runCode(
  apiKey: string,
  code: string,
  language: "python" | "javascript"
): Promise<CodeRunResult> {
  const { Sandbox } = await import("@e2b/code-interpreter");
  const sandbox = await Sandbox.create({ apiKey, timeoutMs: 60_000 });
  try {
    const exec = await sandbox.runCode(code.slice(0, 20_000), {
      language,
      timeoutMs: 55_000,
    });
    const cap = (s: string) => (s.length > 6000 ? s.slice(0, 6000) + "\n…(truncated)" : s);
    return {
      stdout: cap((exec.logs?.stdout ?? []).join("")),
      stderr: cap((exec.logs?.stderr ?? []).join("")),
      results: (exec.results ?? [])
        .map((r: any) => String(r?.text ?? ""))
        .filter(Boolean)
        .slice(0, 5),
      error: exec.error ? `${exec.error.name}: ${exec.error.value}` : undefined,
    };
  } finally {
    await sandbox.kill().catch(() => {});
  }
}
