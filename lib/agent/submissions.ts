import { getServiceClient } from "./supabase";

/**
 * Form submissions for generated websites: a site's forms POST to the
 * agent's public endpoint; rows land here and are read from the Sites
 * inbox, chat tools, and scheduled tasks.
 */

export interface SiteSubmission {
  id: string;
  site_id: string;
  form_name: string;
  data: Record<string, unknown>;
  ip: string | null;
  is_read: boolean;
  created_at: string;
}

const MAX_FIELDS = 30;
const MAX_VALUE_LEN = 2000;

/** Keep only flat, bounded, string-ish data — what real forms send. */
export function sanitizeSubmissionData(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= MAX_FIELDS) break;
    if (typeof k !== "string" || k.length === 0 || k.length > 60) continue;
    if (v === null || v === undefined) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    out[k] = s.slice(0, MAX_VALUE_LEN);
    n++;
  }
  return out;
}

export async function storeSubmission(
  siteId: string,
  formName: string,
  data: Record<string, string>,
  ip: string | null
): Promise<void> {
  const { error } = await getServiceClient()
    .from("site_submissions")
    .insert({ site_id: siteId, form_name: formName, data, ip });
  if (error) throw new Error("Could not store submission");
}

/** DB-backed rate limit: true when this IP+site exceeded the window cap. */
export async function submissionRateExceeded(
  siteId: string,
  ip: string | null,
  limit = 20,
  windowMinutes = 10
): Promise<boolean> {
  if (!ip) return false;
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const { count } = await getServiceClient()
    .from("site_submissions")
    .select("id", { count: "exact", head: true })
    .eq("site_id", siteId)
    .eq("ip", ip)
    .gte("created_at", since);
  return (count ?? 0) >= limit;
}

export async function listSubmissions(
  siteId: string,
  limit = 50,
  unreadOnly = false
): Promise<SiteSubmission[]> {
  let q = getServiceClient()
    .from("site_submissions")
    .select("*")
    .eq("site_id", siteId)
    .order("created_at", { ascending: false })
    .limit(Math.min(200, Math.max(1, limit)));
  if (unreadOnly) q = q.eq("is_read", false);
  const { data } = await q;
  return (data as SiteSubmission[]) ?? [];
}

export async function submissionCounts(
  siteIds: string[]
): Promise<Record<string, { total: number; unread: number }>> {
  const out: Record<string, { total: number; unread: number }> = {};
  if (siteIds.length === 0) return out;
  const { data } = await getServiceClient()
    .from("site_submissions")
    .select("site_id, is_read")
    .in("site_id", siteIds);
  for (const row of data ?? []) {
    const c = (out[row.site_id] ??= { total: 0, unread: 0 });
    c.total++;
    if (!row.is_read) c.unread++;
  }
  return out;
}

export async function markSubmissionRead(id: string, read: boolean): Promise<void> {
  await getServiceClient().from("site_submissions").update({ is_read: read }).eq("id", id);
}

export async function deleteSubmission(id: string): Promise<void> {
  await getServiceClient().from("site_submissions").delete().eq("id", id);
}
