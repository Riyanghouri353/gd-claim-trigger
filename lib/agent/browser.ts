import { Sandbox } from "@e2b/desktop";
import { createAgentImageFile } from "./files";
import { htmlToText } from "./web";

/**
 * Browser automation on an E2B Desktop sandbox (a cloud Linux desktop with
 * Chrome). One session per conversation, kept in server memory; sandboxes
 * idle past their timeout are killed lazily. Nothing runs on our server.
 */

const SESSION_TTL_MS = 10 * 60 * 1000;

interface BrowserSession {
  desktop: Sandbox;
  lastUsed: number;
  currentUrl: string;
  streamUrl?: string;
}

const sessions = new Map<string, BrowserSession>();

/**
 * Short-lived screenshot bytes for vision grounding (toModelOutput must be
 * synchronous, so the image can't be fetched at conversion time). The tool
 * output itself stays free of base64 — it once bloated every request.
 */
const shotCache = new Map<string, string>();

export function cacheScreenshot(id: string, base64: string): void {
  shotCache.set(id, base64);
  if (shotCache.size > 12) {
    const first = shotCache.keys().next().value;
    if (first) shotCache.delete(first);
  }
}

export function getCachedScreenshot(id: string): string | undefined {
  return shotCache.get(id);
}

function keyOf(conversationId: string | null): string {
  return conversationId || "default";
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function assertHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  return url;
}

async function getSession(key: string, apiKey: string): Promise<BrowserSession> {
  const now = Date.now();
  // Lazy cleanup of idle sessions
  const stale: string[] = [];
  sessions.forEach((s, k) => {
    if (k !== key && now - s.lastUsed > SESSION_TTL_MS) stale.push(k);
  });
  for (const k of stale) {
    sessions.get(k)?.desktop.kill().catch(() => {});
    sessions.delete(k);
  }
  let s = sessions.get(key);
  if (s) {
    s.lastUsed = now;
    await s.desktop.setTimeout(SESSION_TTL_MS).catch(() => {});
    return s;
  }
  const desktop = await Sandbox.create({ apiKey, timeoutMs: SESSION_TTL_MS });
  s = { desktop, lastUsed: now, currentUrl: "" };
  sessions.set(key, s);
  return s;
}

async function snap(
  session: BrowserSession,
  conversationId: string | null
): Promise<{ id: string; path: string }> {
  const bytes = await session.desktop.screenshot();
  const base64 = Buffer.from(bytes).toString("base64");
  const file = await createAgentImageFile(
    "browser-screenshot.png",
    base64,
    "image/png",
    conversationId
  );
  cacheScreenshot(file.id, base64);
  return file;
}

async function currentTitle(session: BrowserSession): Promise<string> {
  try {
    const id = await session.desktop.getCurrentWindowId();
    if (id) return (await session.desktop.getWindowTitle(id)) || "";
  } catch {
    /* no window yet */
  }
  return "";
}

export interface BrowseResult {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  truncated?: boolean;
  screenshotId?: string;
  screenshotPath?: string;
  streamUrl?: string;
  screen?: { width: number; height: number } | null;
  error?: string;
}

/** Render a page in the sandbox's Chrome (JS included) and extract its text. */
export async function browsePage(
  apiKey: string,
  conversationId: string | null,
  rawUrl: string,
  wantScreenshot: boolean
): Promise<BrowseResult> {
  const url = assertHttpUrl(rawUrl).toString();
  const session = await getSession(keyOf(conversationId), apiKey);
  const chrome =
    "google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars " +
    "--window-size=1280,1400 --virtual-time-budget=12000";
  const dom = await session.desktop.commands.run(
    `${chrome} --dump-dom ${shellQuote(url)} 2>/dev/null | head -c 400000`,
    { timeoutMs: 60_000 }
  );
  const html = dom.stdout || "";
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || "";
  const text = htmlToText(html);

  let shot: { id: string; path: string } | undefined;
  if (wantScreenshot) {
    await session.desktop.commands.run(
      `${chrome} --screenshot=/tmp/browse-shot.png ${shellQuote(url)} 2>/dev/null`,
      { timeoutMs: 60_000 }
    );
    try {
      const buf = await session.desktop.files.read("/tmp/browse-shot.png", {
        format: "bytes",
      });
      const base64 = Buffer.from(buf as ArrayBuffer).toString("base64");
      shot = await createAgentImageFile("page-screenshot.png", base64, "image/png", conversationId);
      cacheScreenshot(shot.id, base64);
    } catch {
      /* screenshot is best-effort */
    }
  }

  return {
    ok: true,
    url,
    title,
    text: text.slice(0, 7000),
    truncated: text.length > 7000,
    screenshotId: shot?.id,
    screenshotPath: shot?.path,
  };
}

/** Open a page in the interactive desktop browser; returns a screenshot. */
export async function browserOpen(
  apiKey: string,
  conversationId: string | null,
  rawUrl: string
): Promise<BrowseResult> {
  const url = assertHttpUrl(rawUrl).toString();
  const session = await getSession(keyOf(conversationId), apiKey);
  try {
    await session.desktop.launch("google-chrome", url);
  } catch {
    await session.desktop.open(url);
  }
  session.currentUrl = url;

  // Wait until a Chrome window actually exists (up to ~12s) — screenshotting
  // immediately catches the bare desktop (window title "Xfwm4") instead of
  // the page. Then give the page a moment to render.
  for (let i = 0; i < 12; i++) {
    await wait(1000);
    try {
      const wins = await session.desktop.getApplicationWindows("google-chrome");
      if (wins && wins.length > 0) break;
    } catch {
      /* not up yet */
    }
  }
  await wait(2500);

  if (!session.streamUrl) {
    try {
      await session.desktop.stream.start({ requireAuth: true });
      session.streamUrl = session.desktop.stream.getUrl({
        authKey: session.desktop.stream.getAuthKey(),
      });
    } catch {
      /* live view is a bonus, not required */
    }
  }

  const shot = await snap(session, conversationId);
  const screen = await session.desktop.getScreenSize().catch(() => null);
  return {
    ok: true,
    url,
    title: await currentTitle(session),
    screen,
    screenshotId: shot.id,
    screenshotPath: shot.path,
    streamUrl: session.streamUrl,
  };
}

/** Perform one action in the interactive browser; returns a fresh screenshot. */
export async function browserAct(
  apiKey: string,
  conversationId: string | null,
  action: "click" | "type" | "press" | "scroll" | "screenshot",
  opts: { x?: number; y?: number; text?: string; key?: string; direction?: string }
): Promise<BrowseResult> {
  const key = keyOf(conversationId);
  const session = sessions.get(key);
  if (!session) {
    return { ok: false, error: "No browser session yet — call browser_open first." };
  }
  session.lastUsed = Date.now();
  await session.desktop.setTimeout(SESSION_TTL_MS).catch(() => {});

  switch (action) {
    case "click":
      if (typeof opts.x !== "number" || typeof opts.y !== "number") {
        return { ok: false, error: "click needs x and y coordinates" };
      }
      await session.desktop.leftClick(opts.x, opts.y);
      break;
    case "type":
      if (!opts.text) return { ok: false, error: "type needs text" };
      await session.desktop.write(opts.text);
      break;
    case "press": {
      if (!opts.key) return { ok: false, error: "press needs a key" };
      const parts = opts.key.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
      await session.desktop.press(parts.length > 1 ? parts : parts[0]);
      break;
    }
    case "scroll":
      await session.desktop.scroll(opts.direction === "up" ? "up" : "down", 3);
      break;
    case "screenshot":
      break;
  }
  await wait(900);
  const shot = await snap(session, conversationId);
  return {
    ok: true,
    url: session.currentUrl,
    title: await currentTitle(session),
    screenshotId: shot.id,
    screenshotPath: shot.path,
    streamUrl: session.streamUrl,
  };
}

/** End the interactive session and free the sandbox. */
export async function browserClose(conversationId: string | null): Promise<{ ok: boolean }> {
  const key = keyOf(conversationId);
  const session = sessions.get(key);
  if (session) {
    await session.desktop.kill().catch(() => {});
    sessions.delete(key);
  }
  return { ok: true };
}
