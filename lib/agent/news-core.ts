/**
 * Crypto news — pure core logic (no imports, unit-testable).
 *
 * Design rule (the whole point of this module): the briefing may only state
 * what retrieved evidence supports. Retrieval, normalization, date handling,
 * deduplication, ranking and formatting are deterministic; the AI model only
 * ever sees the evidence records produced here and must not add facts.
 */

export type VerificationStatus = "headline_only" | "article_checked";
export type StoryKind = "news" | "opinion" | "sponsored" | "survey" | "press_release";

export interface NewsArticle {
  title: string;
  url: string;
  source: string;
  /** ISO-8601 with timezone, or null when the feed gave no usable date. */
  publishedAt: string | null;
  /** Feed-provided summary, cleaned of markup. May be "". */
  summary: string;
  retrievedAt: string;
  verificationStatus: VerificationStatus;
}

export interface RankedStory extends NewsArticle {
  score: number;
  reasons: string[];
  kind: StoryKind;
  alsoReportedBy: string[];
  /** The evidence text a summary claim may draw on (summary or article excerpt). */
  evidenceExcerpt: string;
}

export interface FeedDiagnostic {
  source: string;
  ok: boolean;
  count: number;
  error?: string;
}

export interface BriefingEvidence {
  generatedAt: string;
  timeZone: string;
  dateLine: string;
  window: "today" | "recent";
  sourcesOk: string[];
  sourcesFailed: { source: string; error: string }[];
  totalFetched: number;
  datedCount: number;
  undatedCount: number;
  stories: RankedStory[];
  limitations: string[];
}

/* ---------------- text helpers ---------------- */

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function stripCdata(s: string): string {
  const t = s.trim();
  if (t.startsWith("<![CDATA[") && t.endsWith("]]>")) return t.slice(9, -3);
  return s;
}

/** Remove markup from a feed summary and cap its length. */
export function cleanSummary(raw: string, max = 500): string {
  const text = decodeEntities(stripCdata(raw))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

function extractTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeEntities(stripCdata(m[1])).trim() : null;
}

/* ---------------- dates ---------------- */

/**
 * Parse a feed date into a Date, or null. Handles RFC-822 and ISO forms.
 * A date with no timezone designator is treated as UTC (documented choice) —
 * never as "today" unless its instant actually falls on today in the
 * briefing timezone.
 */
export function parseFeedDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // Naive ISO-like forms FIRST: Date.parse would read them in the host's
  // local timezone, making results depend on where the server runs. A naive
  // feed date is always treated as UTC here.
  const naive = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (naive) {
    const [, y, mo, d, h, mi, sec] = naive;
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec ?? 0)));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return new Date(direct);
  return null;
}

/** "YYYY-MM-DD" of an instant in a timezone — the only date key we compare. */
export function localDateKey(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function formatDateLine(d: Date, timeZone: string): string {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
  return `${s} · Pakistan Standard Time (UTC+5)`;
}

export function formatTimeInTz(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

/* ---------------- RSS / Atom parsing ---------------- */

/**
 * Parse one feed's XML into normalized articles. Lenient by design: a bad
 * item is skipped, never fatal; a bad feed yields [] (the caller records the
 * diagnostic). Supports RSS <item> and Atom <entry> shapes used by the major
 * crypto publishers.
 */
export function parseFeedXml(xml: string, source: string, retrievedAt: string): NewsArticle[] {
  const out: NewsArticle[] = [];
  if (!xml || typeof xml !== "string") return out;
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks) {
    const title = extractTag(block, "title");
    let url = extractTag(block, "link");
    if (!url) {
      const href = block.match(/<link[^>]+href="([^"]+)"/i);
      url = href ? href[1] : null;
    }
    if (!title || !url) continue; // missing title or URL → unusable, skip
    const dateRaw =
      extractTag(block, "pubDate") ??
      extractTag(block, "dc:date") ??
      extractTag(block, "published") ??
      extractTag(block, "updated");
    const when = parseFeedDate(dateRaw);
    const summaryRaw =
      extractTag(block, "description") ?? extractTag(block, "summary") ?? "";
    out.push({
      title: decodeEntities(title).replace(/\s+/g, " ").trim(),
      url: url.trim(),
      source,
      publishedAt: when ? when.toISOString() : null,
      summary: cleanSummary(summaryRaw),
      retrievedAt,
      verificationStatus: "headline_only",
    });
  }
  return out;
}

/* ---------------- dedupe ---------------- */

const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "referrer", "source", "output",
]);

/** Canonical form for MATCHING only — display always uses the original URL. */
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    const keep: [string, string][] = [];
    u.searchParams.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (lk.startsWith("utm_") || TRACKING_PARAMS.has(lk)) return;
      keep.push([k, v]);
    });
    keep.sort((a, b) => a[0].localeCompare(b[0]));
    u.search = keep.length ? "?" + keep.map(([k, v]) => `${k}=${v}`).join("&") : "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Dedupe by canonical URL or normalized title; merges source attribution. */
export function dedupeArticles(articles: NewsArticle[]): (NewsArticle & { alsoReportedBy: string[] })[] {
  const byUrl = new Map<string, NewsArticle & { alsoReportedBy: string[] }>();
  const byTitle = new Map<string, NewsArticle & { alsoReportedBy: string[] }>();
  const out: (NewsArticle & { alsoReportedBy: string[] })[] = [];
  for (const a of articles) {
    const cu = canonicalizeUrl(a.url);
    const nt = normalizeTitle(a.title);
    const existing = byUrl.get(cu) ?? (nt ? byTitle.get(nt) : undefined);
    if (existing) {
      if (existing.source !== a.source && !existing.alsoReportedBy.includes(a.source)) {
        existing.alsoReportedBy.push(a.source);
      }
      // Prefer the copy that carries a summary and a date.
      if (!existing.summary && a.summary) existing.summary = a.summary;
      if (!existing.publishedAt && a.publishedAt) existing.publishedAt = a.publishedAt;
      continue;
    }
    const rec = { ...a, alsoReportedBy: [] as string[] };
    byUrl.set(cu, rec);
    if (nt) byTitle.set(nt, rec);
    out.push(rec);
  }
  return out;
}

/* ---------------- selection + ranking ---------------- */

/**
 * Pick the briefing window: stories dated TODAY in the briefing timezone;
 * if fewer than 3, fall back to the last 48 hours (honestly labeled
 * "recent"). Undated stories are never labeled as today's.
 */
export function selectWindow(
  articles: (NewsArticle & { alsoReportedBy: string[] })[],
  now: Date,
  timeZone: string
): { window: "today" | "recent"; stories: (NewsArticle & { alsoReportedBy: string[] })[]; datedCount: number; undatedCount: number } {
  const todayKey = localDateKey(now, timeZone);
  const dated = articles.filter((a) => a.publishedAt);
  const undatedCount = articles.length - dated.length;
  const sorted = [...dated].sort(
    (a, b) => new Date(b.publishedAt as string).getTime() - new Date(a.publishedAt as string).getTime()
  );
  const todays = sorted.filter((a) => localDateKey(new Date(a.publishedAt as string), timeZone) === todayKey);
  if (todays.length >= 3) return { window: "today", stories: todays, datedCount: dated.length, undatedCount };
  const cutoff = now.getTime() - 48 * 3600 * 1000;
  const recent = sorted.filter((a) => new Date(a.publishedAt as string).getTime() >= cutoff);
  return { window: "recent", stories: recent, datedCount: dated.length, undatedCount };
}

const SOURCE_WEIGHT: Record<string, number> = {
  CoinDesk: 6,
  "The Block": 6,
  Cointelegraph: 5,
  Decrypt: 5,
  CryptoSlate: 4,
};

export function classifyKind(title: string, summary: string): StoryKind {
  const t = `${title} ${summary}`.toLowerCase();
  if (/sponsored|press release|advertorial/.test(t)) return "sponsored";
  if (/^opinion[:\s]|opinion:|op-ed|commentary:/.test(t) || /\bopinion\b/.test(title.toLowerCase())) return "opinion";
  if (/survey|poll (finds|says|shows)/.test(t)) return "survey";
  return "news";
}

const SIGNAL_GROUPS: { pattern: RegExp; points: number; reason: string }[] = [
  { pattern: /\b(sec|cftc|regulat\w+|law(suit)?|court|sanction\w*|treasury|licen[cs]e|ban|approved|approval|legislat\w+|senator|congress)\b/, points: 30, reason: "regulation/legal" },
  { pattern: /\b(etf|inflows?|outflows?|blackrock|fidelity|institutional|treasury buys|reserves)\b/, points: 25, reason: "ETF/institutional" },
  { pattern: /\b(hack|exploit|breach|stolen|scam|fraud|drain)\b/, points: 25, reason: "security" },
  { pattern: /\b(binance|coinbase|kraken|exchange|tether|usdt|usdc|stablecoin)\b/, points: 18, reason: "exchange/stablecoin" },
  { pattern: /\b(bitcoin|btc)\b/, points: 15, reason: "Bitcoin" },
  { pattern: /\b(ethereum|eth)\b/, points: 12, reason: "Ethereum" },
  { pattern: /\b(solana|sol)\b/, points: 10, reason: "Solana" },
];

/** Explainable deterministic ranking — no sensationalism bonus. */
export function rankStories(
  stories: (NewsArticle & { alsoReportedBy: string[] })[],
  now: Date
): RankedStory[] {
  const ranked = stories.map((a) => {
    const kind = classifyKind(a.title, a.summary);
    let score = SOURCE_WEIGHT[a.source] ?? 3;
    const reasons: string[] = [];
    const hay = `${a.title} ${a.summary}`.toLowerCase();
    for (const g of SIGNAL_GROUPS) {
      if (g.pattern.test(hay)) {
        score += g.points;
        reasons.push(g.reason);
      }
    }
    if (a.publishedAt) {
      const ageH = (now.getTime() - new Date(a.publishedAt).getTime()) / 3600000;
      if (ageH <= 6) { score += 10; reasons.push("fresh"); }
      else if (ageH <= 12) score += 6;
      else if (ageH <= 24) score += 3;
    }
    if (a.alsoReportedBy.length > 0) {
      score += a.alsoReportedBy.length * 8;
      reasons.push(`also reported by ${a.alsoReportedBy.join(", ")}`);
    }
    if (kind === "opinion") score -= 20;
    if (kind === "survey") score -= 10;
    if (kind === "sponsored" || kind === "press_release") score -= 40;
    return { ...a, score, reasons, kind, evidenceExcerpt: a.summary };
  });
  // Sort by score, then by actual timestamp (never by formatted strings).
  ranked.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    const tx = x.publishedAt ? new Date(x.publishedAt).getTime() : 0;
    const ty = y.publishedAt ? new Date(y.publishedAt).getTime() : 0;
    return ty - tx;
  });
  return ranked;
}

/* ---------------- briefing formatting ---------------- */

const KIND_NOTE: Record<StoryKind, string> = {
  news: "",
  opinion: " (opinion/commentary — the author's view, not verified fact)",
  sponsored: " (sponsored/press material — a company claim, not independent reporting)",
  survey: " (survey result — reported figures, not independently verified)",
  press_release: " (press release — a company claim, not independent reporting)",
};

/**
 * The deterministic briefing: built ONLY from evidence records. This is the
 * fallback output and the floor for the model's answer — it contains no
 * sentiment read and no number that did not come from a feed.
 */
export function formatBriefing(ev: BriefingEvidence): string {
  const lines: string[] = [];
  lines.push("Riyan Agent — Crypto Briefing");
  lines.push(ev.dateLine);
  lines.push("");
  const failedNote = ev.sourcesFailed.length
    ? ` Failed sources: ${ev.sourcesFailed.map((f) => `${f.source} (${f.error})`).join("; ")}.`
    : "";
  if (ev.window === "recent") {
    lines.push(
      `Coverage: fewer than 3 stories dated today were found, so this is a RECENT briefing (last 48 hours), not strictly today. ${ev.totalFetched} articles fetched from ${ev.sourcesOk.join(", ")}; ${ev.datedCount} had usable dates.${failedNote}`
    );
  } else {
    lines.push(
      `Coverage: ${ev.totalFetched} articles fetched from ${ev.sourcesOk.join(", ")}; ${ev.datedCount} had usable dates.${failedNote}`
    );
  }
  if (ev.undatedCount > 0) {
    lines.push(`Note: ${ev.undatedCount} undated article(s) were excluded — an unknown date is never labeled as today.`);
  }
  lines.push("");
  if (ev.stories.length === 0) {
    lines.push("No reliable dated stories were available for this briefing.");
  }
  ev.stories.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}${KIND_NOTE[s.kind]}`);
    if (s.evidenceExcerpt) lines.push(`   ${s.evidenceExcerpt}`);
    else if (s.verificationStatus === "headline_only") {
      lines.push("   (Headline only — the article itself could not be opened, so no detail beyond the headline is claimed.)");
    }
    const when = s.publishedAt
      ? formatTimeInTz(new Date(s.publishedAt), ev.timeZone) + " PKT"
      : "time not given by the feed";
    const also = s.alsoReportedBy.length ? ` · also reported by ${s.alsoReportedBy.join(", ")}` : "";
    lines.push(`   Source: ${s.source} · ${when}${also}`);
    lines.push(`   ${s.url}`);
    lines.push("");
  });
  lines.push("This is a news-only briefing — live prices were not checked, and nothing here is a price claim or investment advice.");
  for (const l of ev.limitations) lines.push(`Limitation: ${l}`);
  return lines.join("\n").trim();
}

/* ---------------- anti-hallucination validation ---------------- */

function numbersIn(text: string): Set<string> {
  const set = new Set<string>();
  const re = /\$?\d[\d,]*(\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const core = m[0].replace(/[$,]/g, "");
    set.add(core);
    const asFloat = parseFloat(core);
    if (!Number.isNaN(asFloat)) set.add(String(asFloat));
  }
  return set;
}

/**
 * The regression guard for the observed failure: find number tokens in a
 * candidate briefing that appear NOWHERE in the evidence corpus (titles,
 * summaries, excerpts, and any explicitly allowed strings like the date
 * line). A flagged number means the writer invented a figure — prices, ETF
 * totals, percentages — and the output must not ship as-is.
 */
export function findUnsupportedNumbers(candidate: string, evidenceTexts: string[], allowed: string[] = []): string[] {
  const corpus = new Set<string>();
  for (const t of evidenceTexts) numbersIn(t).forEach((n) => corpus.add(n));
  for (const t of allowed) numbersIn(t).forEach((n) => corpus.add(n));
  const bad: string[] = [];
  numbersIn(candidate).forEach((n) => {
    if (!corpus.has(n)) bad.push(n);
  });
  return bad;
}

/* ---------------- feed error classification ---------------- */

export function classifyFeedError(status?: number, err?: unknown): string {
  if (typeof status === "number") {
    if (status === 403) return "blocked (HTTP 403)";
    if (status === 404) return "feed not found (HTTP 404)";
    if (status === 429) return "rate limited (HTTP 429)";
    if (status >= 500) return `server error (HTTP ${status})`;
    return `HTTP ${status}`;
  }
  const name = String((err as any)?.name ?? "");
  const msg = String((err as any)?.message ?? "").toLowerCase();
  if (name === "AbortError" || msg.includes("abort") || msg.includes("timeout")) return "timeout";
  if (msg.includes("enotfound") || msg.includes("getaddrinfo")) return "DNS failure";
  return "network error";
}
