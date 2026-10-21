"use client";

import { useEffect, useMemo, useRef, useState, Fragment } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bell,
  Bot,
  Box,
  Brain,
  ChevronDown,
  Cloud,
  Code2,
  Database,
  Globe,
  KeyRound,
  Layers,
  Loader2,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  Monitor,
  Paperclip,
  RotateCcw,
  Search,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  SquarePen,
  Trash2,
  TrendingUp,
  Wallet,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import ThemeToggle from "./theme-toggle";

interface Conversation {
  id: string;
  title: string;
  created_at: string;
}

function toolLabel(part: any): string {
  if (part?.toolName) return part.toolName;
  if (typeof part?.type === "string" && part.type.startsWith("tool-"))
    return part.type.replace("tool-", "");
  return "tool";
}

/** Markdown rendering for assistant messages: tables scroll on mobile, links open in a new tab. */
const mdComponents = {
  a: (props: any) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: (props: any) => (
    <div className="overflow-x-auto">
      <table {...props} />
    </div>
  ),
};

/** A pending chat attachment: vision file (data URL) or inlined text file. */
type Attachment =
  | { kind: "file"; name: string; mediaType: string; url: string }
  | { kind: "text"; name: string; text: string };

function readFileAs(f: File, mode: "dataURL" | "text"): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    if (mode === "dataURL") r.readAsDataURL(f);
    else r.readAsText(f);
  });
}

const TEXT_FILE_RE = /\.(txt|md|csv|json|log|js|ts|tsx|py|html|css|xml|yml|yaml)$/i;

/** Turn a raw chat error into something a human can act on. */
function friendlyError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("network error") || m.includes("failed to fetch") || m.includes("load failed"))
    return "Network error — your connection dropped. Check your signal and hit Retry.";
  if (m.includes("rate limit") || m.includes("429") || m.includes("too many"))
    return "Rate limit hit — too much too fast. Wait a few seconds, then hit Retry; your keys rotate automatically.";
  if (m.includes("keys failed") || m.includes("502") || m.includes("no active"))
    return "All API keys failed or none are configured. Check Settings → Keys.";
  return `Something went wrong: ${msg}`;
}

/** Pretty-print a JSON-ish value for the tool inspector. */
function prettyJson(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      return s;
    }
  } catch {
    return String(v);
  }
}

/** Expandable inspector for a tool call: tap to see the request and response. */
function ToolCallCard({ part }: { part: any }) {
  const [open, setOpen] = useState(false);
  const name: string = toolLabel(part);
  const input: any = part.input ?? {};
  const output: any = part.output;
  const state: string = part.state ?? "";
  const done = state === "output-available";
  const failed = state === "output-error";
  const running = !done && !failed;
  const isConnector = name === "call_connector";

  const requestView = isConnector
    ? {
        connector: input.connector,
        method: input.method,
        path: input.path,
        ...(input.query && Object.keys(input.query).length ? { query: input.query } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      }
    : input;

  return (
    <div className="mt-2 overflow-hidden rounded-xl border bg-muted/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {running ? (
            <>Calling <b className="text-foreground">{isConnector ? input.connector || name : name}</b>…</>
          ) : (
            <>
              Used <b className="text-foreground">{isConnector ? input.connector || name : name}</b>{" "}
              {failed ? "✗" : "✓"}
            </>
          )}
        </span>
        {done && output && typeof output.status === "number" && (
          <Badge variant={output.ok ? "success" : "destructive"}>{output.status}</Badge>
        )}
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="border-t px-3 py-2.5">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Request
          </p>
          <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/40 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
            {prettyJson(requestView)}
          </pre>
          <p className="mb-1 mt-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Response
          </p>
          {done && output ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/40 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
              {typeof output.body === "string"
                ? `HTTP ${output.status}\n${prettyJson(output.body)}${
                    output.truncated ? "\n…(truncated)" : ""
                  }`
                : prettyJson(output)}
            </pre>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {failed ? part.errorText || "Tool failed" : "Waiting for response…"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** GitHub mark (lucide dropped brand icons) — simple-icons path. */
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.15c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 1.94-.75.4-1.25.7-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 1.28 1.06.82.57 1.11 1.83 0 1.07-.01 2.9-.01 3.29 0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

/** Icons the model can pick for guide cards, by name. */
const GUIDE_ICONS: Record<string, any> = {
  github: GithubIcon,
  monitor: Monitor,
  server: Server,
  database: Database,
  globe: Globe,
  shield: ShieldCheck,
  zap: Zap,
  layers: Layers,
  box: Box,
  cloud: Cloud,
  phone: Smartphone,
  code: Code2,
  chart: BarChart3,
  wallet: Wallet,
  bot: Bot,
  key: KeyRound,
  mail: Mail,
  bell: Bell,
};

function guideBadge(tone?: string): { variant?: "success" | "default" | "secondary" | "destructive"; className?: string } {
  switch (tone) {
    case "green":
      return { variant: "success" };
    case "red":
      return { variant: "destructive" };
    case "gray":
      return { variant: "secondary" };
    case "amber":
      return { className: "border-transparent bg-amber-500/15 text-amber-400" };
    default:
      return { variant: "default" };
  }
}

function GuideMiniCard({ card }: { card: any }) {
  const Icon = GUIDE_ICONS[String(card?.icon || "").toLowerCase()] || Box;
  const badgeProps = card?.badge ? guideBadge(card.badgeTone) : null;
  return (
    <div className="rounded-xl border bg-muted/40 p-4">
      <div className="mb-2.5 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-5" />
      </div>
      <p className="text-[15px] font-semibold leading-snug">{card?.title}</p>
      {card?.badge && (
        <Badge {...badgeProps} className={`mt-2 ${badgeProps?.className || ""}`}>
          {card.badge}
        </Badge>
      )}
      {Array.isArray(card?.lines) &&
        card.lines.map((l: string, i: number) => (
          <p key={i} className="mt-1.5 text-sm leading-relaxed text-foreground/85">
            {l}
          </p>
        ))}
      {card?.muted && <p className="mt-1.5 text-xs text-muted-foreground">{card.muted}</p>}
    </div>
  );
}

/** ChatGPT-style visual guide: titled cards connected by flow arrows. */
function GuideCard({ input }: { input: any }) {
  const blocks: any[] = Array.isArray(input?.blocks) ? input.blocks : [];
  if (!input?.title || blocks.length === 0) return null;
  return (
    <div className="mt-2">
      <h3 className="mb-2 text-base font-bold tracking-tight">{input.title}</h3>
      <div className="rounded-2xl border bg-card/60 p-3">
        {blocks.map((b: any, i: number) => (
          <Fragment key={i}>
            {i > 0 && (
              <div className="flex justify-center py-1.5">
                <ArrowDown className="size-4 text-muted-foreground" />
              </div>
            )}
            {b?.kind === "row" && Array.isArray(b.cards) && b.cards.length > 0 ? (
              <div
                className={`grid gap-3 ${
                  b.cards.length >= 3 ? "sm:grid-cols-3" : b.cards.length === 2 ? "sm:grid-cols-2" : ""
                }`}
              >
                {b.cards.map((c: any, j: number) => (
                  <GuideMiniCard key={j} card={c} />
                ))}
              </div>
            ) : (
              <GuideMiniCard card={b} />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** Bucket a conversation timestamp into a recency group for the sidebar. */
function dayBucket(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Older";
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  return "Older";
}

const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Older"];

const SUGGESTIONS = [
  { icon: TrendingUp, label: "Today's crypto market news", prompt: "Give me today's top crypto market news in a concise briefing" },
  { icon: ShieldAlert, label: "How to spot a crypto scam", prompt: "Explain how to spot a crypto scam — the red flags to check before investing" },
  { icon: Code2, label: "Run code: compound interest", prompt: "Run Python code to calculate compound interest on Rs 100,000 at 12% for 5 years, year by year" },
  { icon: Brain, label: "What do you remember about me?", prompt: "What do you remember about me from past conversations?" },
];

export default function ChatApp() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  const cidRef = useRef<string | null>(null);
  const [, forceRender] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  const transportRef = useRef<DefaultChatTransport<UIMessage> | null>(null);
  if (!transportRef.current) {
    transportRef.current = new DefaultChatTransport<UIMessage>({
      api: "/api/agent/chat",
      body: () => ({ conversationId: cidRef.current }),
    });
  }

  const { messages, sendMessage, status, error, regenerate, setMessages } = useChat({
    transport: transportRef.current,
  });

  const busy = status === "submitted" || status === "streaming";

  async function refreshList() {
    const res = await fetch("/api/agent/conversations");
    if (res.ok) {
      const j = await res.json();
      setConversations(j.conversations ?? []);
    }
  }

  useEffect(() => {
    refreshList();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  function setConversation(id: string | null) {
    cidRef.current = id;
    forceRender((n) => n + 1);
  }

  async function openConversation(id: string) {
    setConversation(id);
    setSidebarOpen(false);
    const res = await fetch(`/api/agent/conversations/${id}/messages`);
    if (res.ok) {
      const j = await res.json();
      setMessages(j.messages ?? []);
    }
  }

  function newChat() {
    setConversation(null);
    setMessages([]);
    setSidebarOpen(false);
  }

  async function handleFilesSelected(list: FileList | null) {
    if (!list) return;
    const next: Attachment[] = [];
    for (const f of Array.from(list).slice(0, 4)) {
      if (f.size > 4 * 1024 * 1024) {
        alert(`"${f.name}" is too large (max 4 MB).`);
        continue;
      }
      try {
        if (f.type.startsWith("text/") || TEXT_FILE_RE.test(f.name)) {
          next.push({ kind: "text", name: f.name, text: await readFileAs(f, "text") });
        } else {
          next.push({ kind: "file", name: f.name, mediaType: f.type || "application/octet-stream", url: await readFileAs(f, "dataURL") });
        }
      } catch { /* unreadable file — skip */ }
    }
    setAttachments((a) => [...a, ...next].slice(0, 4));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function submitText(text: string, atts: Attachment[]) {
    const files = atts
      .filter((a): a is Extract<Attachment, { kind: "file" }> => a.kind === "file")
      .map((a) => ({ type: "file" as const, mediaType: a.mediaType, filename: a.name, url: a.url }));
    let fullText = text;
    for (const a of atts) {
      if (a.kind === "text") {
        fullText += `\n\n[Attached file: ${a.name}]\n\`\`\`\n${a.text.slice(0, 20000)}\n\`\`\``;
      }
    }
    if (!fullText.trim()) fullText = "Please review the attached file(s).";
    if (!cidRef.current) {
      const res = await fetch("/api/agent/conversations", { method: "POST" });
      if (!res.ok) return;
      const j = await res.json();
      setConversation(j.id);
      refreshList();
    }
    sendMessage(files.length ? { text: fullText, files } : { text: fullText });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if ((!text && attachments.length === 0) || busy) return;
    setInput("");
    const atts = attachments;
    setAttachments([]);
    await submitText(text, atts);
  }

  async function deleteConversation(id: string) {
    await fetch(`/api/agent/conversations/${id}`, { method: "DELETE" });
    if (cidRef.current === id) {
      setConversation(null);
      setMessages([]);
    }
    refreshList();
  }

  async function logout() {
    await fetch("/api/agent/auth/logout", { method: "POST" });
    router.push("/agent/login");
    router.refresh();
  }

  /** Conversations filtered by search, grouped by recency. Pure client-side. */
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? conversations.filter((c) =>
          (c.title || "New chat").toLowerCase().includes(q)
        )
      : conversations;
    const buckets = new Map<string, Conversation[]>();
    for (const c of filtered) {
      const b = dayBucket(c.created_at);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b)!.push(c);
    }
    return GROUP_ORDER.filter((g) => (buckets.get(g) ?? []).length > 0).map(
      (label) => ({ label, items: buckets.get(label)! })
    );
  }, [conversations, search]);

  const activeId = cidRef.current;
  const canSend = !busy && (!!input.trim() || attachments.length > 0);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — drawer on mobile, fixed on desktop */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[280px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-200 md:static md:w-72 md:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Brand */}
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-sidebar-border px-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-[#4f44d6] text-white shadow-lg shadow-black/40">
            <Sparkles className="size-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight">Riyan Agent</p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-emerald-400" />
              Ready
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSidebarOpen(false)}
            className="md:hidden"
            aria-label="Close menu"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* Actions */}
        <div className="shrink-0 space-y-2 px-3 pt-3">
          <Button onClick={newChat} className="w-full justify-start">
            <SquarePen />
            New chat
          </Button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="pl-9"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Conversations */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {groups.length === 0 && !search && (
            <div className="flex flex-col items-center px-6 py-10 text-center">
              <div className="flex size-11 items-center justify-center rounded-2xl border bg-card text-muted-foreground">
                <MessageSquare className="size-5" />
              </div>
              <p className="mt-3 text-sm font-medium text-muted-foreground">
                No conversations yet
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground/70">
                Start a new chat above — your history will appear here.
              </p>
            </div>
          )}
          {groups.length === 0 && search && (
            <p className="px-2 py-10 text-center text-xs leading-relaxed text-muted-foreground">
              No chats match “{search.trim()}”.
            </p>
          )}
          {groups.map((g) => (
            <div key={g.label} className="mb-4 last:mb-0">
              <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                {g.label}
              </p>
              <ul className="space-y-0.5">
                {g.items.map((c) => {
                  const active = activeId === c.id;
                  const title = c.title || "New chat";
                  return (
                    <li key={c.id}>
                      <div
                        className={cn(
                          "group relative flex items-center rounded-lg transition-colors",
                          active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
                        )}
                      >
                        {active && (
                          <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                        )}
                        <button
                          onClick={() => openConversation(c.id)}
                          aria-current={active ? true : undefined}
                          title={title}
                          className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 pr-1 text-left"
                        >
                          <MessageSquare
                            className={cn(
                              "size-4 shrink-0",
                              active ? "text-primary" : "text-muted-foreground"
                            )}
                          />
                          <span
                            className={cn(
                              "truncate text-sm",
                              active ? "font-medium" : "text-muted-foreground group-hover:text-foreground"
                            )}
                          >
                            {title}
                          </span>
                        </button>
                        <button
                          onClick={() => setPendingDelete(c)}
                          className="mr-1.5 shrink-0 rounded-lg p-1.5 text-muted-foreground transition-all hover:bg-destructive/10 hover:text-destructive md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                          title="Delete chat"
                          aria-label={`Delete chat: ${title}`}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        {/* Footer — profile row */}
        <div className="shrink-0 border-t border-sidebar-border p-3">
          <div className="flex items-center gap-3 rounded-xl px-2 py-1.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
              R
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">Riyan</p>
              <p className="truncate text-[11px] text-muted-foreground">
                Personal workspace
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.push("/agent/sites")}
              title="My websites"
              aria-label="My websites"
            >
              <Globe className="size-[18px]" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.push("/agent/settings")}
              title="Settings & keys"
              aria-label="Settings & keys"
            >
              <Settings className="size-[18px]" />
            </Button>
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              onClick={logout}
              title="Log out"
              aria-label="Log out"
            >
              <LogOut className="size-[18px]" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Chat */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex shrink-0 items-center gap-2 border-b px-2 py-2 md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </Button>
          <span className="truncate text-sm font-semibold">Riyan Agent</span>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.length === 0 && (
              <div className="pt-10 text-center md:pt-16">
                <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-[#4f44d6] text-white shadow-xl shadow-primary/20">
                  <Sparkles className="size-7" />
                </div>
                <h1 className="mt-5 text-2xl font-bold tracking-tight md:text-3xl">
                  How can I help today?
                </h1>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground md:text-base">
                  I remember, read links, run code, create files and call your connected APIs.
                </p>
                <div className="mx-auto mt-8 grid max-w-lg grid-cols-1 gap-2.5 text-left sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.label}
                      onClick={() => !busy && submitText(s.prompt, [])}
                      className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm transition-colors hover:border-primary/50 hover:bg-accent"
                    >
                      <s.icon className="size-4 shrink-0 text-primary" />
                      <span className="min-w-0 truncate">{s.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id}>
                {m.role === "user" ? (
                  <div className="flex justify-end">
                    <div className="max-w-[90%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-[15px] leading-relaxed text-primary-foreground md:max-w-[85%]">
                      {m.parts.map((part: any, i: number) => {
                        if (part.type === "file") {
                          return part.mediaType?.startsWith("image/") && part.url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              key={i}
                              src={part.url}
                              alt={part.filename || "attachment"}
                              className="mb-2 max-h-56 rounded-xl object-contain"
                            />
                          ) : (
                            <p
                              key={i}
                              className="mb-2 inline-flex items-center gap-1.5 rounded-lg bg-black/25 px-2.5 py-1.5 text-xs"
                            >
                              <Paperclip className="size-3" /> {part.filename || "attachment"}
                            </p>
                          );
                        }
                        if (part.type === "text") {
                          return (
                            <p key={i} className="whitespace-pre-wrap break-words">
                              {part.text}
                            </p>
                          );
                        }
                        return null;
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-[#4f44d6] text-white">
                      <Sparkles className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1 pt-1 text-[15px] leading-relaxed">
                      {m.parts.map((part: any, i: number) => {
                        if (part.type === "text") {
                          return (
                            <div key={i} className="agent-md break-words">
                              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                                {part.text}
                              </ReactMarkdown>
                            </div>
                          );
                        }
                        if (typeof part.type === "string" && part.type.includes("tool")) {
                          if (toolLabel(part) === "show_guide") {
                            if (part.state === "output-available" && part.input) {
                              return <GuideCard key={i} input={part.input} />;
                            }
                            if (part.state === "output-error") {
                              return <ToolCallCard key={i} part={part} />;
                            }
                            return (
                              <p key={i} className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                                <Loader2 className="size-3.5 animate-spin" />
                                Preparing visual guide…
                              </p>
                            );
                          }
                          const out: any = part.output;
                          return (
                            <Fragment key={i}>
                              <ToolCallCard part={part} />
                              {part.state === "output-available" && out?.screenshotPath && (
                                <figure className="mt-2 overflow-hidden rounded-xl border">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={out.screenshotPath}
                                    alt={out.title || "Browser screenshot"}
                                    className="w-full object-cover"
                                    loading="lazy"
                                  />
                                  <figcaption className="flex items-center justify-between gap-2 bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                                    <span className="flex min-w-0 items-center gap-1.5">
                                      <Globe className="size-3.5 shrink-0" />
                                      <span className="truncate">{out.title || out.url || "Screenshot"}</span>
                                    </span>
                                    {out.streamUrl && (
                                      <a
                                        href={out.streamUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="shrink-0 font-medium text-primary hover:underline"
                                      >
                                        Watch live
                                      </a>
                                    )}
                                  </figcaption>
                                </figure>
                              )}
                              {part.state === "output-available" &&
                                (out?.previewUrl || (out?.liveUrl && (out?.target === "production" || out?.status === "live"))) && (
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    {out.previewUrl && (
                                      <a
                                        href={out.previewUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="rounded-full border px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-muted"
                                      >
                                        Open preview ↗
                                      </a>
                                    )}
                                    {out.liveUrl && (out?.target === "production" || out?.status === "live") && (
                                      <a
                                        href={out.liveUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                                      >
                                        Open live site ↗
                                      </a>
                                    )}
                                  </div>
                                )}
                            </Fragment>
                          );
                        }
                        return null;
                      })}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {busy && messages[messages.length - 1]?.role === "user" && (
              <div className="flex gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-[#4f44d6] text-white">
                  <Sparkles className="size-4" />
                </div>
                <div className="flex items-center gap-1.5 pt-3" aria-label="Thinking">
                  <span className="size-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.2s]" />
                  <span className="size-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.1s]" />
                  <span className="size-2 animate-bounce rounded-full bg-muted-foreground" />
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm">
                <p className="text-destructive">{error ? friendlyError(error.message) : ""}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => regenerate()}
                  className="mt-3"
                >
                  <RotateCcw />
                  Retry
                </Button>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="shrink-0 p-3 md:p-4">
          <form
            onSubmit={handleSubmit}
            className="mx-auto max-w-3xl rounded-3xl border bg-card p-2 shadow-lg shadow-black/20 focus-within:border-primary/60"
          >
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 px-2 pb-2 pt-1">
                {attachments.map((a, i) => (
                  <Badge key={i} variant="secondary" className="gap-1.5 py-1 pl-2.5 pr-1.5 text-xs">
                    <Paperclip className="size-3" />
                    <span className="max-w-40 truncate">{a.name}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                      className="rounded-full p-0.5 hover:bg-white/10"
                      aria-label={`Remove ${a.name}`}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <div className="flex items-end gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.csv,.json,.log,.js,.ts,.tsx,.py,.html,.css,.xml,.yml,.yaml"
                className="hidden"
                onChange={(e) => handleFilesSelected(e.target.files)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => fileInputRef.current?.click()}
                className="shrink-0 rounded-full"
                aria-label="Attach files"
                title="Attach image or file"
              >
                <Paperclip className="size-5" />
              </Button>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
                  }
                }}
                placeholder="Message Riyan Agent…"
                rows={1}
                className="field-sizing-content max-h-40 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2.5 text-[15px] outline-none placeholder:text-muted-foreground"
              />
              <Button
                type="submit"
                size="icon"
                disabled={!canSend}
                className="shrink-0 rounded-full"
                aria-label="Send message"
              >
                <ArrowUp className="size-5" />
              </Button>
            </div>
          </form>
          <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-muted-foreground/70">
            Riyan Agent can make mistakes. Verify important information.
          </p>
        </div>
      </main>

      {/* Delete conversation confirmation */}
      <Dialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this chat?</DialogTitle>
            <DialogDescription>
              “{pendingDelete?.title || "New chat"}” and all its messages will be permanently
              deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDelete) deleteConversation(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
