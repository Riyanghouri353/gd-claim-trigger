"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";

interface Conversation {
  id: string;
  title: string;
}

function toolLabel(part: any): string {
  if (part?.toolName) return part.toolName;
  if (typeof part?.type === "string" && part.type.startsWith("tool-"))
    return part.type.replace("tool-", "");
  return "tool";
}

export default function ChatApp() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
        className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 transition-transform duration-200 md:static md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between p-3 pb-0">
          <button
            onClick={newChat}
            className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500"
          >
            + New chat
          </button>
          <button
            onClick={() => setSidebarOpen(false)}
            className="ml-2 rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 md:hidden"
            aria-label="Close menu"
          >
            ✕
          </button>
        </div>
        <div className="chat-scroll flex-1 space-y-1 overflow-y-auto px-2 py-2">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center rounded-lg px-3 py-2 text-sm ${
                cidRef.current === c.id ? "bg-zinc-800" : "hover:bg-zinc-900"
              }`}
            >
              <button onClick={() => openConversation(c.id)} className="flex-1 truncate text-left">
                {c.title || "New chat"}
              </button>
              <button
                onClick={() => deleteConversation(c.id)}
                className="ml-2 hidden text-zinc-500 hover:text-red-400 group-hover:block"
                title="Delete"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="border-t border-zinc-800 p-3">
          <button
            onClick={() => router.push("/agent/settings")}
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-900"
          >
            ⚙ Settings & keys
          </button>
          <button
            onClick={logout}
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          >
            Log out
          </button>
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
            <span className="block text-xl leading-none">☰</span>
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
                      return (
                        <p key={i} className="whitespace-pre-wrap break-words">
                          {part.text}
                        </p>
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
