"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

/** Tiny inline SVG icon (lucide-style strokes). */
function I({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
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

export default function ChatApp() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    if (!cidRef.current) {
      const res = await fetch("/api/agent/conversations", { method: "POST" });
      if (!res.ok) return;
      const j = await res.json();
      setConversation(j.id);
      refreshList();
    }
    sendMessage({ text });
  }

  async function deleteConversation(id: string) {
    if (!confirm("Delete this chat?")) return;
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

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — drawer on mobile, fixed on desktop */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[280px] shrink-0 flex-col bg-zinc-950 transition-transform duration-200 md:static md:w-72 md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Brand */}
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-zinc-800/60 px-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-lg shadow-indigo-950/50">
            <I className="h-[18px] w-[18px]"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" /></I>
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight text-zinc-100">
              Riyan Agent
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Ready
            </p>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-300 md:hidden"
            aria-label="Close menu"
          >
            <I className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12" /></I>
          </button>
        </div>

        {/* Actions */}
        <div className="shrink-0 space-y-2 px-3 pt-3">
          <button
            onClick={newChat}
            className="flex h-10 w-full items-center gap-2.5 rounded-xl bg-indigo-600 px-3.5 text-sm font-medium text-white shadow-md shadow-indigo-950/40 transition hover:bg-indigo-500 active:scale-[0.99]"
          >
            <I className="h-4 w-4"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></I>
            New chat
          </button>
          <label className="flex h-9 items-center gap-2 rounded-xl bg-zinc-900/80 px-3 text-sm ring-1 ring-zinc-800/60 transition focus-within:ring-indigo-500/60">
            <I className="h-4 w-4 shrink-0 text-zinc-600"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></I>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="w-full min-w-0 bg-transparent text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="shrink-0 rounded-md p-0.5 text-zinc-500 transition-colors hover:text-zinc-300"
                aria-label="Clear search"
              >
                <I className="h-3.5 w-3.5"><path d="M18 6 6 18M6 6l12 12" /></I>
              </button>
            )}
          </label>
        </div>

        {/* Conversations */}
        <div className="chat-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {groups.length === 0 && !search && (
            <div className="flex flex-col items-center px-6 py-10 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-zinc-900 text-zinc-600 ring-1 ring-zinc-800/60">
                <I className="h-5 w-5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></I>
              </div>
              <p className="mt-3 text-sm font-medium text-zinc-400">
                No conversations yet
              </p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-600">
                Start a new chat above — your history will appear here.
              </p>
            </div>
          )}
          {groups.length === 0 && search && (
            <p className="px-2 py-10 text-center text-xs leading-relaxed text-zinc-600">
              No chats match “{search.trim()}”.
            </p>
          )}
          {groups.map((g) => (
            <div key={g.label} className="mb-4 last:mb-0">
              <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                {g.label}
              </p>
              <ul className="space-y-0.5">
                {g.items.map((c) => {
                  const active = activeId === c.id;
                  const title = c.title || "New chat";
                  return (
                    <li key={c.id}>
                      <div
                        className={`group relative flex items-center rounded-xl transition-colors ${
                          active ? "bg-zinc-800/90" : "hover:bg-zinc-900"
                        }`}
                      >
                        {active && (
                          <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-indigo-500" />
                        )}
                        <button
                          onClick={() => openConversation(c.id)}
                          aria-current={active ? true : undefined}
                          title={title}
                          className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pl-3 pr-1 text-left"
                        >
                          <I
                            className={`h-4 w-4 shrink-0 ${
                              active ? "text-indigo-400" : "text-zinc-600"
                            }`}
                          >
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          </I>
                          <span
                            className={`truncate text-sm ${
                              active
                                ? "font-medium text-zinc-100"
                                : "text-zinc-400 group-hover:text-zinc-200"
                            }`}
                          >
                            {title}
                          </span>
                        </button>
                        <button
                          onClick={() => deleteConversation(c.id)}
                          className="mr-1.5 shrink-0 rounded-lg p-1.5 text-zinc-600 transition-all hover:bg-red-500/10 hover:text-red-400 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                          title="Delete chat"
                          aria-label={`Delete chat: ${title}`}
                        >
                          <I className="h-4 w-4"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></I>
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
        <div className="shrink-0 border-t border-zinc-800/60 p-3">
          <div className="flex items-center gap-3 rounded-xl px-2 py-1.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-sm font-semibold text-zinc-200 ring-1 ring-zinc-700/50">
              R
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-zinc-200">Riyan</p>
              <p className="truncate text-[11px] text-zinc-500">
                Personal workspace
              </p>
            </div>
            <button
              onClick={() => router.push("/agent/settings")}
              className="shrink-0 rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
              title="Settings & keys"
              aria-label="Settings & keys"
            >
              <I className="h-[18px] w-[18px]">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </I>
            </button>
            <button
              onClick={logout}
              className="shrink-0 rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
              title="Log out"
              aria-label="Log out"
            >
              <I className="h-[18px] w-[18px]">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="m16 17 5-5-5-5" />
                <path d="M21 12H9" />
              </I>
            </button>
          </div>
        </div>
      </aside>

      {/* Chat */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-2 py-2 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded-lg p-2 text-zinc-200 hover:bg-zinc-900"
            aria-label="Open menu"
          >
            <I className="h-5 w-5"><path d="M4 6h16M4 12h16M4 18h16" /></I>
          </button>
          <span className="truncate text-sm font-semibold">Riyan Agent</span>
        </div>

        <div className="chat-scroll flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-5">
            {messages.length === 0 && (
              <div className="pt-16 text-center md:pt-24">
                <h1 className="text-2xl font-bold md:text-3xl">Riyan Agent</h1>
                <p className="mt-2 text-sm text-zinc-400 md:text-base">
                  Ask anything. I can search the web when it helps.
                </p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[90%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed md:max-w-[85%] ${
                    m.role === "user" ? "bg-indigo-600 text-white" : "bg-zinc-900 text-zinc-100"
                  }`}
                >
                  {m.parts.map((part: any, i: number) => {
                    if (part.type === "text") {
                      return m.role === "user" ? (
                        <p key={i} className="whitespace-pre-wrap break-words">
                          {part.text}
                        </p>
                      ) : (
                        <div key={i} className="agent-md break-words">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                            {part.text}
                          </ReactMarkdown>
                        </div>
                      );
                    }
                    if (typeof part.type === "string" && part.type.includes("tool")) {
                      return (
                        <p key={i} className="mt-1 text-xs text-zinc-400">
                          🔧 used {toolLabel(part)}
                          {part.state === "output-available" || part.output ? " ✓" : "…"}
                        </p>
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            ))}
            {busy && messages[messages.length - 1]?.role === "user" && (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-zinc-900 px-4 py-3 text-sm text-zinc-400">
                  Thinking…
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-xl border border-red-900 bg-red-950/40 p-4 text-sm">
                <p className="text-red-300">Something went wrong: {error.message}</p>
                <button
                  onClick={() => regenerate()}
                  className="mt-2 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700"
                >
                  ↻ Retry
                </button>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="shrink-0 border-t border-zinc-800 p-3 md:p-4">
          <form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message Riyan Agent…"
              className="min-w-0 flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="shrink-0 rounded-xl bg-indigo-600 px-4 py-3 font-medium hover:bg-indigo-500 disabled:opacity-50 md:px-5"
            >
              Send
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
