import { getSetting, setSetting } from "./keys";
import { encryptSecret, decryptSecret } from "./crypto";
import { getServiceClient } from "./supabase";

/**
 * Website-builder hosting credentials (Vercel + Cloudflare API tokens),
 * stored as one AES-256-GCM encrypted JSON blob in app_settings — the same
 * pattern as the E2B key. Tokens never leave the server.
 */

const SETTING_KEY = "site_hosting_enc";

export interface HostingConfig {
  vercelToken?: string;
  vercelTeamId?: string;
  cloudflareToken?: string;
}

export async function getHostingConfig(): Promise<HostingConfig> {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(decryptSecret(JSON.parse(raw))) as HostingConfig;
  } catch {
    return {};
  }
}

export async function setHostingConfig(patch: HostingConfig): Promise<HostingConfig> {
  const current = await getHostingConfig();
  const next: HostingConfig = { ...current };
  if (patch.vercelToken !== undefined)
    next.vercelToken = patch.vercelToken.trim() || undefined;
  if (patch.vercelTeamId !== undefined)
    next.vercelTeamId = patch.vercelTeamId.trim() || undefined;
  if (patch.cloudflareToken !== undefined)
    next.cloudflareToken = patch.cloudflareToken.trim() || undefined;
  const bundle = encryptSecret(JSON.stringify(next));
  await setSetting(SETTING_KEY, JSON.stringify(bundle));
  return next;
}

export async function deleteHostingConfig(): Promise<void> {
  await getServiceClient().from("app_settings").delete().eq("key", SETTING_KEY);
}

export async function testVercelToken(
  token: string
): Promise<{ ok: boolean; error?: string; username?: string }> {
  try {
    const res = await fetch("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "Invalid Vercel token" };
    if (!res.ok) return { ok: false, error: `Vercel returned ${res.status}` };
    const data: any = await res.json().catch(() => ({}));
    return { ok: true, username: data?.user?.username };
  } catch {
    return { ok: false, error: "Network error reaching Vercel" };
  }
}

export async function testCloudflareToken(
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data?.result?.status !== "active") {
      return { ok: false, error: data?.errors?.[0]?.message || `Cloudflare returned ${res.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error reaching Cloudflare" };
  }
}
