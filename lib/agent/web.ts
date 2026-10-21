import { assertPublicUrl, fetchWithTimeout } from "./connectors";

/** Strip HTML down to readable text (scripts/styles/nav removed). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|article|section)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Fetch a public URL and return its readable text (SSRF-guarded, capped).
 * Used by the read_url chat tool.
 */
export async function fetchPublicText(
  rawUrl: string,
  maxChars = 6000
): Promise<{ ok: boolean; status: number; text: string; truncated: boolean }> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  await assertPublicUrl(url);
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; RiyanAgent/1.0)", Accept: "text/html,application/json,text/plain" },
  });
  const raw = await res.text();
  const type = res.headers.get("content-type") || "";
  const text = type.includes("html") || raw.trimStart().startsWith("<") ? htmlToText(raw) : raw;
  return {
    ok: res.ok,
    status: res.status,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}
