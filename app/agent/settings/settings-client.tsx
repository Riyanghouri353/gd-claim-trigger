"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface KeyRow {
  id: string;
  label: string;
  disabled: boolean;
  cooldown_until: string | null;
  last_used_at: string | null;
  created_at: string;
}

const MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
  "qwen/qwen3-32b",
];

export default function SettingsClient() {
  const router = useRouter();
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [label, setLabel] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [model, setModel] = useState(MODELS[0]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [saved, setSaved] = useState(false);

  async function load() {
    const [kr, sr] = await Promise.all([fetch("/api/agent/keys"), fetch("/api/agent/settings")]);
    if (kr.ok) setKeys((await kr.json()).keys ?? []);
    if (sr.ok) {
      const j = await sr.json();
      setModel(j.chat_model || MODELS[0]);
      setSystemPrompt(j.system_prompt || "");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/agent/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, key: keyValue }),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMsg("❌ " + (j.error || "Failed"));
      return;
    }
    setLabel("");
    setKeyValue("");
    setMsg("✅ Key added and verified");
    load();
  }

  async function deleteKey(id: string) {
    if (!confirm("Delete this key?")) return;
    await fetch(`/api/agent/keys/${id}`, { method: "DELETE" });
    load();
  }

  async function testKey(id: string) {
    setMsg("Testing…");
    const res = await fetch(`/api/agent/keys/${id}/test`, { method: "POST" });
    const j = await res.json();
    setMsg(j.ok ? "✅ Key works" : "❌ " + (j.error || "Failed"));
    load();
  }

  async function saveSettings() {
    setSaved(false);
    const res = await fetch("/api/agent/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_model: model, system_prompt: systemPrompt }),
    });
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
        <button onClick={() => router.push("/agent")} className="text-sm text-indigo-400 hover:underline">
          ← Back to chat
        </button>
      </div>

      {msg && <p className="mb-4 text-sm">{msg}</p>}

      <section className="mb-8 rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="mb-3 text-lg font-semibold">Groq API keys</h2>
        <p className="mb-4 text-sm text-zinc-400">
          Keys are AES-256 encrypted in Supabase and tested before saving. Requests rotate
          across healthy keys; rate-limited keys cool down automatically.
        </p>
        <div className="mb-4 space-y-2">
          {keys.length === 0 && <p className="text-sm text-zinc-500">No keys yet — add your first below.</p>}
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between rounded-lg bg-zinc-900 px-4 py-2.5">
              <div>
                <p className="text-sm font-medium">{k.label}</p>
                <p className="text-xs text-zinc-500">
                  {k.disabled ? "⛔ disabled" : k.cooldown_until && new Date(k.cooldown_until) > new Date() ? "⏳ cooling down" : "✅ active"}
                  {k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleString()}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => testKey(k.id)} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700">
                  Test
                </button>
                <button onClick={() => deleteKey(k.id)} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
        <form onSubmit={addKey} className="flex flex-col gap-2 sm:flex-row">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. account-1)"
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <input
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            placeholder="gsk_…"
            type="password"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={busy || !label.trim() || !keyValue.trim()}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? "Verifying…" : "Add key"}
          </button>
        </form>
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="mb-3 text-lg font-semibold">Agent</h2>
        <label className="mb-1 block text-sm text-zinc-400">Model</label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="mb-4 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none"
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <label className="mb-1 block text-sm text-zinc-400">System prompt</label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={4}
          placeholder="Leave empty for the default personality…"
          className="mb-4 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
        />
        <button
          onClick={saveSettings}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500"
        >
          Save
        </button>
        {saved && <span className="ml-3 text-sm text-green-400">Saved ✓</span>}
      </section>
    </main>
  );
}
