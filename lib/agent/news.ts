import { assertPublicUrl, fetchWithTimeout } from "./connectors";
import { fetchPublicText } from "./web";
import {
  BriefingEvidence,
  FeedDiagnostic,
  NewsArticle,
  RankedStory,
  classifyFeedError,
  dedupeArticles,
  extractArticleEvidence,
  formatBriefing,
  formatDateLine,
  parseFeedXml,
  rankStories,
  selectWindow,
} from "./news-core";

/**
 * Crypto news retrieval: multiple reputable RSS feeds, fetched server-side
 * with timeouts and per-source diagnostics. A failed feed never fails the
 * briefing — it is reported in the coverage note instead.
 */

export interface NewsFeed {
  source: string;
  url: string;
}

export const NEWS_FEEDS: NewsFeed[] = [
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { source: "Decrypt", url: "https://decrypt.co/feed" },
  { source: "The Block", url: "https://www.theblock.co/rss.xml" },
  { source: "CryptoSlate", url: "https://cryptoslate.com/feed/" },
];

const MAX_FEED_BYTES = 1_500_000;
export const NEWS_TIMEZONE = "Asia/Karachi";

async function fetchFeed(feed: NewsFeed, retrievedAt: string): Promise<{ articles: NewsArticle[]; diag: FeedDiagnostic }> {
  try {
    const url = new URL(feed.url);
    await assertPublicUrl(url);
    const res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": "RiyanAgent-news/1.0", Accept: "application/rss+xml, application/xml, text/xml" } },
      15000
    );
    if (!res.ok) {
      return { articles: [], diag: { source: feed.source, ok: false, count: 0, error: classifyFeedError(res.status) } };
    }
    const xml = (await res.text()).slice(0, MAX_FEED_BYTES);
    const articles = parseFeedXml(xml, feed.source, retrievedAt);
    if (articles.length === 0) {
      return { articles: [], diag: { source: feed.source, ok: false, count: 0, error: "feed returned no parseable articles" } };
    }
    return { articles, diag: { source: feed.source, ok: true, count: articles.length } };
  } catch (e: any) {
    return { articles: [], diag: { source: feed.source, ok: false, count: 0, error: classifyFeedError(undefined, e) } };
  }
}

export interface CryptoBriefingResult {
  evidence: BriefingEvidence;
  /** Deterministic, evidence-only briefing text (the safe fallback output). */
  briefing: string;
}

/**
 * Build today's crypto briefing evidence (Asia/Karachi). The top stories can
 * be article-checked: the original article is fetched and its opening text
 * becomes the evidence excerpt; if that fails the story stays headline-only
 * and is labeled as such — never silently upgraded.
 */
export async function getCryptoBriefing(opts?: {
  limit?: number;
  verifyTop?: number;
  now?: Date;
  feeds?: NewsFeed[];
}): Promise<CryptoBriefingResult> {
  const now = opts?.now ?? new Date();
  const retrievedAt = now.toISOString();
  const feeds = opts?.feeds ?? NEWS_FEEDS;
  const limit = Math.min(Math.max(opts?.limit ?? 5, 1), 7);
  const verifyTop = Math.min(Math.max(opts?.verifyTop ?? 2, 0), 3);

  const results = await Promise.all(feeds.map((f) => fetchFeed(f, retrievedAt)));
  const all: NewsArticle[] = [];
  const diagnostics: FeedDiagnostic[] = [];
  for (const r of results) {
    all.push(...r.articles);
    diagnostics.push(r.diag);
  }

  const deduped = dedupeArticles(all);
  const sel = selectWindow(deduped, now, NEWS_TIMEZONE);
  const ranked = rankStories(sel.stories, now);
  const top: RankedStory[] = ranked.slice(0, limit);

  // Article verification for the top stories: the story is upgraded only
  // when a substantive paragraph matching the headline is extracted from
  // the article — page chrome and price tickers never count as evidence.
  for (let i = 0; i < Math.min(verifyTop, top.length); i++) {
    const story = top[i];
    try {
      const page = await fetchPublicText(story.url, 12000);
      if (page.ok) {
        const excerpt = extractArticleEvidence(page.text, story.title);
        if (excerpt) {
          story.verificationStatus = "article_checked";
          story.evidenceExcerpt = excerpt;
        }
      }
    } catch {
      /* stays headline_only — labeled in the output */
    }
  }

  const evidence: BriefingEvidence = {
    generatedAt: retrievedAt,
    timeZone: NEWS_TIMEZONE,
    dateLine: formatDateLine(now, NEWS_TIMEZONE),
    window: sel.window,
    sourcesOk: diagnostics.filter((d) => d.ok).map((d) => d.source),
    sourcesFailed: diagnostics
      .filter((d) => !d.ok)
      .map((d) => ({ source: d.source, error: d.error ?? "unknown error" })),
    totalFetched: all.length,
    datedCount: sel.datedCount,
    undatedCount: sel.undatedCount,
    stories: top,
    limitations: [
      "Live market prices are not part of this briefing; news headlines do not establish price movements or market sentiment.",
    ],
  };
  return { evidence, briefing: formatBriefing(evidence) };
}
