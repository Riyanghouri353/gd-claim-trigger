"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../agent-theme.module.css";

interface KeyRow {
  id: string;
  label: string;
  disabled: boolean;
  cooldown_until: string | null;
  last_used_at: string | null;
  created_at: string;
}

interface ConnectorRow {
  id: string;
  name: string;
  baseUrl: string;
  authType: string;
  enabled: boolean;
  created_at: string;
}

const AUTH_TYPES = [
  { value: "bearer", label: "Bearer token (Authorization header)" },
  { value: "header", label: "Custom header" },
  { value: "query", label: "Query parameter" },
  { value: "basic", label: "Basic auth (username + key)" },
  { value: "none", label: "No auth" },
];

const MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "google/gemini-3-flash-preview",
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
  const [gKeys, setGKeys] = useState<KeyRow[]>([]);
  const [gLabel, setGLabel] = useState("");
  const [gKeyValue, setGKeyValue] = useState("");
  const [gBusy, setGBusy] = useState(false);
  const [gMsg, setGMsg] = useState("");
  const [lKeys, setLKeys] = useState<KeyRow[]>([]);
  const [lLabel, setLLabel] = useState("");
  const [lKeyValue, setLKeyValue] = useState("");
  const [lBusy, setLBusy] = useState(false);
  const [lMsg, setLMsg] = useState("");
  const [connectors, setConnectors] = useState<ConnectorRow[]>([]);
  const [cName, setCName] = useState("");
  const [cBaseUrl, setCBaseUrl] = useState("");
  const [cAuthType, setCAuthType] = useState("bearer");
  const [cAuthField, setCAuthField] = useState("");
  const [cKey, setCKey] = useState("");
  const [cTestPath, setCTestPath] = useState("");
  const [cBusy, setCBusy] = useState(false);
  const [cMsg, setCMsg] = useState("");
  const [dService, setDService] = useState("");
  const [dBusy, setDBusy] = useState(false);
  const [dNote, setDNote] = useState("");

  async function load() {
    const [kr, gkr, lkr, sr, cr] = await Promise.all([
      fetch("/api/agent/keys"),
      fetch("/api/agent/gemini-keys"),
      fetch("/api/agent/lovable-keys"),
      fetch("/api/agent/settings"),
      fetch("/api/agent/connectors"),
    ]);
    if (kr.ok) setKeys((await kr.json()).keys ?? []);
    if (gkr.ok) setGKeys((await gkr.json()).keys ?? []);
    if (lkr.ok) setLKeys((await lkr.json()).keys ?? []);
    if (cr.ok) setConnectors((await cr.json()).connectors ?? []);
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

  async function addGKey(e: React.FormEvent) {
    e.preventDefault();
    setGBusy(true);
    setGMsg("");
    const res = await fetch("/api/agent/gemini-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: gLabel, key: gKeyValue }),
    });
    const j = await res.json();
    setGBusy(false);
    if (!res.ok) {
      setGMsg("❌ " + (j.error || "Failed"));
      return;
    }
    setGLabel("");
    setGKeyValue("");
    setGMsg("✅ Key added and verified");
    load();
  }

  async function deleteGKey(id: string) {
    if (!confirm("Delete this key?")) return;
    await fetch(`/api/agent/gemini-keys/${id}`, { method: "DELETE" });
    load();
  }

  async function testGKey(id: string) {
    setGMsg("Testing…");
    const res = await fetch(`/api/agent/gemini-keys/${id}/test`, { method: "POST" });
    const j = await res.json();
    setGMsg(j.ok ? "✅ Key works" : "❌ " + (j.error || "Failed"));
    load();
  }

  async function addLKey(e: React.FormEvent) {
    e.preventDefault();
    setLBusy(true);
    setLMsg("");
    const res = await fetch("/api/agent/lovable-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: lLabel, key: lKeyValue }),
    });
    const j = await res.json();
    setLBusy(false);
    if (!res.ok) {
      setLMsg("❌ " + (j.error || "Failed"));
      return;
    }
    setLLabel("");
    setLKeyValue("");
    setLMsg("✅ Key added and verified");
    load();
  }

  async function deleteLKey(id: string) {
    if (!confirm("Delete this key?")) return;
    await fetch(`/api/agent/lovable-keys/${id}`, { method: "DELETE" });
    load();
  }

  async function testLKey(id: string) {
    setLMsg("Testing…");
    const res = await fetch(`/api/agent/lovable-keys/${id}/test`, { method: "POST" });
    const j = await res.json();
    setLMsg(j.ok ? "✅ Key works" : "❌ " + (j.error || "Failed"));
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

  async function addConnector(e: React.FormEvent) {
    e.preventDefault();
    setCBusy(true);
    setCMsg("");
    const res = await fetch("/api/agent/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: cName,
        baseUrl: cBaseUrl,
        authType: cAuthType,
        authField: cAuthField,
        key: cKey,
        testPath: cTestPath,
      }),
    });
    const j = await res.json();
    setCBusy(false);
    if (!res.ok) {
      setCMsg("❌ " + (j.error || "Failed"));
      return;
    }
    setCName("");
    setCBaseUrl("");
    setCAuthField("");
    setCKey("");
    setCTestPath("");
    setCMsg("✅ Connector saved and verified (" + (j.detail || "ok") + ")");
    load();
  }

  async function deleteConnector(id: string) {
    if (!confirm("Delete this connector?")) return;
    await fetch(`/api/agent/connectors/${id}`, { method: "DELETE" });
    load();
  }

  async function discoverService(e: React.FormEvent) {
    e.preventDefault();
    if (!dService.trim() || dBusy) return;
    setDBusy(true);
    setDNote("");
    try {
      const res = await fetch("/api/agent/connectors/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: dService.trim() }),
      });
      const j = await res.json();
      if (!res.ok) {
        setDNote("❌ " + (j.error || "Discovery failed"));
        return;
      }
      if (j.baseUrl) setCBaseUrl(j.baseUrl);
      setCAuthType(j.authType || "bearer");
      setCAuthField(j.authField || "");
      setCTestPath(j.testPath || "");
      if (!cName.trim()) setCName(dService.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"));
      const conf = j.confidence === "high" ? "✅" : j.confidence === "medium" ? "⚠️" : "❓";
      setDNote(
        `${conf} Details filled${j.confidence !== "high" ? " (low confidence — verify before saving)" : ""}` +
        (j.keyHint ? ` · Key: ${j.keyHint}` : "")
      );
    } catch {
      setDNote("❌ Discovery failed");
    } finally {
      setDBusy(false);
    }
  }

  async function toggleConnector(id: string, enabled: boolean) {
    await fetch(`/api/agent/connectors/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    load();
  }

  const authFieldLabel =
    cAuthType === "header" ? "Header name (e.g. X-API-Key)" :
    cAuthType === "query" ? "Query param name (e.g. api_key)" :
    cAuthType === "basic" ? "Username" : "";

  return (
    <div className={`${styles.theme} min-h-screen bg-[var(--ag-bg)]`}>
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

      <section className="mb-8 rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="mb-3 text-lg font-semibold">Gemini API keys</h2>
        <p className="mb-4 text-sm text-zinc-400">
          Free keys from{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="underline">
            aistudio.google.com/apikey
          </a>
          . Same vault, same rotation — chat automatically falls back across Groq,
          Gemini and Lovable when a provider's keys are rate-limited.
        </p>
        {gMsg && <p className="mb-4 text-sm">{gMsg}</p>}
        <div className="mb-4 space-y-2">
          {gKeys.length === 0 && <p className="text-sm text-zinc-500">No keys yet — add your first below.</p>}
          {gKeys.map((k) => (
            <div key={k.id} className="flex items-center justify-between rounded-lg bg-zinc-900 px-4 py-2.5">
              <div>
                <p className="text-sm font-medium">{k.label}</p>
                <p className="text-xs text-zinc-500">
                  {k.disabled ? "⛔ disabled" : k.cooldown_until && new Date(k.cooldown_until) > new Date() ? "⏳ cooling down" : "✅ active"}
                  {k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleString()}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => testGKey(k.id)} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700">
                  Test
                </button>
                <button onClick={() => deleteGKey(k.id)} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
        <form onSubmit={addGKey} className="flex flex-col gap-2 sm:flex-row">
          <input
            value={gLabel}
            onChange={(e) => setGLabel(e.target.value)}
            placeholder="Label (e.g. gemini-1)"
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <input
            value={gKeyValue}
            onChange={(e) => setGKeyValue(e.target.value)}
            placeholder="AIza…"
            type="password"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={gBusy || !gLabel.trim() || !gKeyValue.trim()}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {gBusy ? "Verifying…" : "Add key"}
          </button>
        </form>
      </section>

      <section className="mb-8 rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="mb-3 text-lg font-semibold">Lovable AI Gateway keys</h2>
        <p className="mb-4 text-sm text-zinc-400">
          Keys for{" "}
          <span className="font-mono text-xs">ai.gateway.lovable.dev</span> — OpenAI-compatible
          gateway. Add as many as you like; chat rotates across them and falls back here
          automatically when Groq and Gemini keys are exhausted.
        </p>
        {lMsg && <p className="mb-4 text-sm">{lMsg}</p>}
        <div className="mb-4 space-y-2">
          {lKeys.length === 0 && <p className="text-sm text-zinc-500">No keys yet — add your first below.</p>}
          {lKeys.map((k) => (
            <div key={k.id} className="flex items-center justify-between rounded-lg bg-zinc-900 px-4 py-2.5">
              <div>
                <p className="text-sm font-medium">{k.label}</p>
                <p className="text-xs text-zinc-500">
                  {k.disabled ? "⛔ disabled" : k.cooldown_until && new Date(k.cooldown_until) > new Date() ? "⏳ cooling down" : "✅ active"}
                  {k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleString()}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => testLKey(k.id)} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700">
                  Test
                </button>
                <button onClick={() => deleteLKey(k.id)} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
        <form onSubmit={addLKey} className="flex flex-col gap-2 sm:flex-row">
          <input
            value={lLabel}
            onChange={(e) => setLLabel(e.target.value)}
            placeholder="Label (e.g. lovable-1)"
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <input
            value={lKeyValue}
            onChange={(e) => setLKeyValue(e.target.value)}
            placeholder="Lovable API key"
            type="password"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={lBusy || !lLabel.trim() || !lKeyValue.trim()}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {lBusy ? "Verifying…" : "Add key"}
          </button>
        </form>
      </section>

      <section className="mb-8 rounded-2xl border border-[var(--ag-border)] bg-[var(--ag-sidebar)] p-5">
        <h2 className="mb-3 text-lg font-semibold text-[var(--ag-text)]">API connectors</h2>
        <p className="mb-4 text-sm text-[var(--ag-muted)]">
          Save API keys for services your agent can call from chat (email, domains,
          anything with an HTTP API). Keys are AES-256 encrypted in Supabase, tested
          before saving, and never sent to your browser. Add them here — not in chat,
          so they never land in chat history.
        </p>
        {cMsg && <p className="mb-4 text-sm text-[var(--ag-text)]">{cMsg}</p>}
        <form onSubmit={discoverService} className="mb-3 flex flex-col gap-2 sm:flex-row">
          <input
            value={dService}
            onChange={(e) => setDService(e.target.value)}
            placeholder="Service name — e.g. Resend, Cloudflare, GitHub"
            className="flex-1 rounded-lg border border-[var(--ag-border)] bg-[var(--ag-surface)] px-3 py-2 text-sm text-[var(--ag-text)] outline-none placeholder:text-[var(--ag-faint)] focus:border-[var(--ag-accent)]"
          />
          <button
            type="submit"
            disabled={dBusy || !dService.trim()}
            className="shrink-0 rounded-lg bg-[var(--ag-surface-2)] px-4 py-2 text-sm font-medium text-[var(--ag-text)] hover:bg-[var(--ag-active)] disabled:opacity-50"
          >
            {dBusy ? "Looking up…" : "✨ Auto-fill details"}
          </button>
        </form>
        {dNote && <p className="mb-3 text-xs text-[var(--ag-muted)]">{dNote}</p>}
        <div className="mb-4 space-y-2">
          {connectors.length === 0 && (
            <p className="text-sm text-[var(--ag-faint)]">No connectors yet — add your first below.</p>
          )}
          {connectors.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between rounded-xl bg-[var(--ag-surface)] px-4 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[var(--ag-text)]">{c.name}</p>
                <p className="truncate text-xs text-[var(--ag-faint)]">
                  {c.enabled ? "✅ enabled" : "⏸ disabled"} · {c.authType} · {c.baseUrl}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => toggleConnector(c.id, !c.enabled)}
                  className="rounded-lg bg-[var(--ag-surface-2)] px-3 py-1.5 text-xs text-[var(--ag-text)] hover:bg-[var(--ag-active)]"
                >
                  {c.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  onClick={() => deleteConnector(c.id)}
                  className="rounded-lg bg-[var(--ag-surface-2)] px-3 py-1.5 text-xs text-[var(--ag-danger)] hover:bg-[var(--ag-active)]"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
        <form onSubmit={addConnector} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input
            value={cName}
            onChange={(e) => setCName(e.target.value)}
            placeholder="Name (e.g. resend)"
            className="rounded-lg border border-[var(--ag-border)] bg-[var(--ag-surface)] px-3 py-2 text-sm text-[var(--ag-text)] outline-none placeholder:text-[var(--ag-faint)] focus:border-[var(--ag-accent)]"
          />
          <input
            value={cBaseUrl}
            onChange={(e) => setCBaseUrl(e.target.value)}
            placeholder="Base URL (https://api.example.com)"
            className="rounded-lg border border-[var(--ag-border)] bg-[var(--ag-surface)] px-3 py-2 text-sm text-[var(--ag-text)] outline-none placeholder:text-[var(--ag-faint)] focus:border-[var(--ag-accent)]"
          />
          <select
            value={cAuthType}
            onChange={(e) => setCAuthType(e.target.value)}
            className="rounded-lg border border-[var(--ag-border)] bg-[var(--ag-surface)] px-3 py-2 text-sm text-[var(--ag-text)] outline-none"
          >
            {AUTH_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          {authFieldLabel ? (
            <input
              value={cAuthField}
              onChange={(e) => setCAuthField(e.target.value)}
              placeholder={authFieldLabel}
              className="rounded-lg border border-[var(--ag-border)] bg-[var(--ag-surface)] px-3 py-2 text-sm text-[var(--ag-text)] outline-none placeholder:text-[var(--ag-faint)] focus:border-[var(--ag-accent)]"
            />
          ) : (
            <input
              value={cTestPath}
              onChange={(e) => setCTestPath(e.target.value)}
              placeholder="Test path (optional, e.g. /v1/models)"
              className="rounded-lg border border-[var(--ag-border)] bg-[var(--ag-surface)] px-3 py-2 text-sm text-[var(--ag-text)] outline-none placeholder:text-[var(--ag-faint)] focus:border-[var(--ag-accent)]"
            />
          )}
          {cAuthType !== "none" && (
            <input
              value={cKey}
              onChange={(e) => setCKey(e.target.value)}
              placeholder="API key / token"
              type="password"
              className="rounded-lg border border-[var(--ag-border)] bg-[var(--ag-surface)] px-3 py-2 text-sm text-[var(--ag-text)] outline-none placeholder:text-[var(--ag-faint)] focus:border-[var(--ag-accent)]"
            />
          )}
          {authFieldLabel && (
            <input
              value={cTestPath}
              onChange={(e) => setCTestPath(e.target.value)}
              placeholder="Test path (optional)"
              className="rounded-lg border border-[var(--ag-border)] bg-[var(--ag-surface)] px-3 py-2 text-sm text-[var(--ag-text)] outline-none placeholder:text-[var(--ag-faint)] focus:border-[var(--ag-accent)]"
            />
          )}
          <button
            type="submit"
            disabled={cBusy || !cName.trim() || !cBaseUrl.trim() || (cAuthType !== "none" && !cKey.trim())}
            className="rounded-lg bg-[var(--ag-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--ag-accent-hover)] disabled:opacity-50 sm:col-span-2"
          >
            {cBusy ? "Testing…" : "Save connector"}
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
    </div>
  );
}
