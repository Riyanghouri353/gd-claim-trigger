"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Brain,
  CheckCircle2,
  Code2,
  Globe,
  KeyRound,
  Loader2,
  Plug,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import ThemeToggle from "../theme-toggle";

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

interface TestAccountRow {
  id: string;
  site: string;
  label: string;
  email: string;
  username: string;
  generated: boolean;
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

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";

function Msg({ text }: { text: string }) {
  if (!text) return null;
  const bad = text.startsWith("❌");
  const good = text.startsWith("✅");
  return (
    <p className={`flex items-center gap-1.5 text-sm ${bad ? "text-destructive" : good ? "text-emerald-400" : "text-muted-foreground"}`}>
      {bad ? <XCircle className="size-4 shrink-0" /> : good ? <CheckCircle2 className="size-4 shrink-0" /> : null}
      {text.replace(/^[❌✅]\s*/, "")}
    </p>
  );
}

function KeyStatus({ k }: { k: KeyRow }) {
  if (k.disabled) return <Badge variant="destructive">Disabled</Badge>;
  if (k.cooldown_until && new Date(k.cooldown_until) > new Date())
    return <Badge variant="secondary">Cooling down</Badge>;
  return <Badge variant="success">Active</Badge>;
}

interface ConfirmState {
  title: string;
  description: string;
  actionLabel: string;
  run: () => void;
}

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
  const [memories, setMemories] = useState<{ id: string; content: string; created_at: string }[]>([]);
  const [newMemory, setNewMemory] = useState("");
  const [memMsg, setMemMsg] = useState("");
  const [e2bConfigured, setE2bConfigured] = useState(false);
  const [e2bKeyValue, setE2bKeyValue] = useState("");
  const [e2bBusy, setE2bBusy] = useState(false);
  const [e2bMsg, setE2bMsg] = useState("");
  const [siteVercel, setSiteVercel] = useState(false);
  const [siteCloudflare, setSiteCloudflare] = useState(false);
  const [vercelTokenValue, setVercelTokenValue] = useState("");
  const [vercelTeamValue, setVercelTeamValue] = useState("");
  const [cfTokenValue, setCfTokenValue] = useState("");
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteMsg, setSiteMsg] = useState("");
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
  const [accounts, setAccounts] = useState<TestAccountRow[]>([]);
  const [aSite, setASite] = useState("");
  const [aLabel, setALabel] = useState("");
  const [aEmail, setAEmail] = useState("");
  const [aUsername, setAUsername] = useState("");
  const [aPassword, setAPassword] = useState("");
  const [aBusy, setABusy] = useState(false);
  const [aMsg, setAMsg] = useState("");
  const [aDomain, setADomain] = useState("example.com");
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  async function load() {
    const [kr, gkr, lkr, sr, cr, mr, er, scr] = await Promise.all([
      fetch("/api/agent/keys"),
      fetch("/api/agent/gemini-keys"),
      fetch("/api/agent/lovable-keys"),
      fetch("/api/agent/settings"),
      fetch("/api/agent/connectors"),
      fetch("/api/agent/memories"),
      fetch("/api/agent/e2b-key"),
      fetch("/api/agent/site-config"),
    ]);
    if (scr.ok) {
      const j = await scr.json();
      setSiteVercel(!!j.vercel);
      setSiteCloudflare(!!j.cloudflare);
      setVercelTeamValue(j.vercelTeamId || "");
    }
    if (kr.ok) setKeys((await kr.json()).keys ?? []);
    if (gkr.ok) setGKeys((await gkr.json()).keys ?? []);
    if (lkr.ok) setLKeys((await lkr.json()).keys ?? []);
    if (mr.ok) setMemories((await mr.json()).memories ?? []);
    if (er.ok) setE2bConfigured(!!(await er.json()).configured);
    if (cr.ok) setConnectors((await cr.json()).connectors ?? []);
    const tar = await fetch("/api/agent/test-accounts").catch(() => null);
    if (tar && tar.ok) {
      const j = await tar.json();
      setAccounts(j.accounts ?? []);
      if (j.emailDomain) setADomain(j.emailDomain);
    }
    if (sr.ok) {
      const j = await sr.json();
      setModel(j.chat_model || MODELS[0]);
      setSystemPrompt(j.system_prompt || "");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function addAccount(e: React.FormEvent) {
    e.preventDefault();
    setABusy(true);
    setAMsg("");
    const res = await fetch("/api/agent/test-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site: aSite, label: aLabel, email: aEmail, username: aUsername, password: aPassword }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.account) {
      setAccounts((prev) => [j.account, ...prev]);
      setASite(""); setALabel(""); setAEmail(""); setAUsername(""); setAPassword("");
      setAMsg("✅ Test account saved — your agent can now log in with it via secure tokens");
    } else {
      setAMsg("❌ " + (j.error || "Could not save the account"));
    }
    setABusy(false);
  }

  async function generateAccount() {
    if (!aSite.trim()) {
      setAMsg("❌ Enter the site first, then generate an identity for it");
      return;
    }
    setABusy(true);
    setAMsg("");
    const res = await fetch("/api/agent/test-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generate: true, site: aSite }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.account) {
      setAccounts((prev) => [j.account, ...prev]);
      setAMsg(`✅ Identity generated: ${j.account.email} / ${j.account.username} — password is stored in the vault (the agent uses it via tokens, it is never shown in chat)`);
    } else {
      setAMsg("❌ " + (j.error || "Could not generate an identity"));
    }
    setABusy(false);
  }

  async function removeAccount(id: string) {
    const res = await fetch(`/api/agent/test-accounts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setAccounts((prev) => prev.filter((a) => a.id !== id));
  }

  async function saveDomain() {
    const res = await fetch("/api/agent/test-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emailDomain: aDomain }),
    });
    if (res.ok) setAMsg("✅ Test email domain saved");
  }

  function confirm(cs: ConfirmState) {
    setConfirmState(cs);
  }

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

  async function addMemoryManual(e: React.FormEvent) {
    e.preventDefault();
    if (!newMemory.trim()) return;
    const res = await fetch("/api/agent/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: newMemory.trim() }),
    });
    if (res.ok) {
      setNewMemory("");
      setMemMsg("✅ Memory saved");
    } else {
      setMemMsg("❌ Could not save");
    }
    load();
  }

  async function deleteMemoryUI(id: string) {
    await fetch(`/api/agent/memories/${id}`, { method: "DELETE" });
    load();
  }

  async function saveE2BKey(e: React.FormEvent) {
    e.preventDefault();
    setE2bBusy(true);
    setE2bMsg("");
    const res = await fetch("/api/agent/e2b-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: e2bKeyValue }),
    });
    const j = await res.json();
    setE2bBusy(false);
    if (!res.ok) {
      setE2bMsg("❌ " + (j.error || "Failed"));
      return;
    }
    setE2bKeyValue("");
    setE2bMsg("✅ E2B key saved — code execution is on");
    load();
  }

  async function removeE2BKey() {
    await fetch("/api/agent/e2b-key", { method: "DELETE" });
    setE2bMsg("E2B key removed");
    load();
  }

  async function saveSiteConfig(e: React.FormEvent) {
    e.preventDefault();
    setSiteBusy(true);
    setSiteMsg("");
    const res = await fetch("/api/agent/site-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vercelToken: vercelTokenValue || undefined,
        vercelTeamId: vercelTeamValue,
        cloudflareToken: cfTokenValue || undefined,
      }),
    });
    const j = await res.json().catch(() => ({}));
    setSiteBusy(false);
    if (!res.ok) {
      setSiteMsg("❌ " + (j.error || "Failed to save"));
      return;
    }
    setVercelTokenValue("");
    setCfTokenValue("");
    setSiteMsg("✅ Hosting tokens saved — the website builder is ready");
    load();
  }

  async function removeSiteConfig() {
    await fetch("/api/agent/site-config", { method: "DELETE" });
    setSiteMsg("Hosting tokens removed");
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

  function keySection(p: {
    icon: React.ReactNode;
    title: string;
    description: React.ReactNode;
    rows: KeyRow[];
    msgText: string;
    labelVal: string;
    setLabelVal: (v: string) => void;
    keyVal: string;
    setKeyVal: (v: string) => void;
    keyPlaceholder: string;
    busyFlag: boolean;
    onAdd: (e: React.FormEvent) => void;
    onTest: (id: string) => void;
    onDelete: (id: string) => void;
  }) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">{p.icon}</span>
            {p.title}
          </CardTitle>
          <CardDescription>{p.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Msg text={p.msgText} />
          <div className="space-y-2">
            {p.rows.length === 0 && (
              <p className="text-sm text-muted-foreground">No keys yet — add your first below.</p>
            )}
            {p.rows.map((k) => (
              <div key={k.id} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{k.label}</span>
                    <KeyStatus k={k} />
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {k.last_used_at ? `Last used ${new Date(k.last_used_at).toLocaleString()}` : "Never used"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" onClick={() => p.onTest(k.id)}>
                    Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() =>
                      confirm({
                        title: "Delete this key?",
                        description: `The key “${k.label}” will be removed from the vault.`,
                        actionLabel: "Delete",
                        run: () => p.onDelete(k.id),
                      })
                    }
                  >
                    <Trash2 />
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <form onSubmit={p.onAdd} className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={p.labelVal}
              onChange={(e) => p.setLabelVal(e.target.value)}
              placeholder="Label (e.g. account-1)"
              className="sm:w-44"
            />
            <Input
              value={p.keyVal}
              onChange={(e) => p.setKeyVal(e.target.value)}
              placeholder={p.keyPlaceholder}
              type="password"
              className="flex-1"
            />
            <Button type="submit" disabled={p.busyFlag || !p.labelVal.trim() || !p.keyVal.trim()}>
              {p.busyFlag && <Loader2 className="animate-spin" />}
              {p.busyFlag ? "Verifying…" : "Add key"}
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Button variant="ghost" onClick={() => router.push("/agent")}>
            <ArrowLeft />
            Back to chat
          </Button>
        </div>
      </div>

      {keySection({
        icon: <KeyRound className="size-4" />,
        title: "Groq API keys",
        description:
          "Keys are AES-256 encrypted in Supabase and tested before saving. Requests rotate across healthy keys; rate-limited keys cool down automatically.",
        rows: keys,
        msgText: msg,
        labelVal: label,
        setLabelVal: setLabel,
        keyVal: keyValue,
        setKeyVal: setKeyValue,
        keyPlaceholder: "gsk_…",
        busyFlag: busy,
        onAdd: addKey,
        onTest: testKey,
        onDelete: deleteKey,
      })}

      {keySection({
        icon: <Sparkles className="size-4" />,
        title: "Gemini API keys",
        description: (
          <>
            Free keys from{" "}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="underline">
              aistudio.google.com/apikey
            </a>
            . Same vault, same rotation — chat automatically falls back across Groq, Gemini
            and Lovable when a provider's keys are rate-limited.
          </>
        ),
        rows: gKeys,
        msgText: gMsg,
        labelVal: gLabel,
        setLabelVal: setGLabel,
        keyVal: gKeyValue,
        setKeyVal: setGKeyValue,
        keyPlaceholder: "AIza…",
        busyFlag: gBusy,
        onAdd: addGKey,
        onTest: testGKey,
        onDelete: deleteGKey,
      })}

      {keySection({
        icon: <Sparkles className="size-4" />,
        title: "Lovable AI Gateway keys",
        description: (
          <>
            Keys for <span className="font-mono text-xs">ai.gateway.lovable.dev</span> — an
            OpenAI-compatible gateway. Add as many as you like; chat rotates across them and
            falls back here automatically when Groq and Gemini keys are exhausted.
          </>
        ),
        rows: lKeys,
        msgText: lMsg,
        labelVal: lLabel,
        setLabelVal: setLLabel,
        keyVal: lKeyValue,
        setKeyVal: setLKeyValue,
        keyPlaceholder: "Lovable API key",
        busyFlag: lBusy,
        onAdd: addLKey,
        onTest: testLKey,
        onDelete: deleteLKey,
      })}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Brain className="size-4" />
            </span>
            Memory
          </CardTitle>
          <CardDescription>
            Facts your agent remembers about you across all conversations. It saves them
            automatically when you share something durable — review or delete them here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Msg text={memMsg} />
          <div className="space-y-2">
            {memories.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nothing remembered yet — tell your agent something about yourself.
              </p>
            )}
            {memories.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-2.5">
                <p className="min-w-0 flex-1 text-sm">{m.content}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() =>
                    confirm({
                      title: "Forget this memory?",
                      description: m.content,
                      actionLabel: "Forget",
                      run: () => deleteMemoryUI(m.id),
                    })
                  }
                >
                  Forget
                </Button>
              </div>
            ))}
          </div>
          <form onSubmit={addMemoryManual} className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={newMemory}
              onChange={(e) => setNewMemory(e.target.value)}
              placeholder="Add a memory — e.g. My bakery is called Al Khair Trader"
              className="flex-1"
            />
            <Button type="submit" disabled={!newMemory.trim()}>
              Remember
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Code2 className="size-4" />
            </span>
            Code execution + Browser (E2B)
          </CardTitle>
          <CardDescription>
            Lets your agent run Python/JavaScript in a secure E2B cloud sandbox — never on
            this server. The same key also powers browser automation (a cloud desktop with
            Chrome). Get a free key at{" "}
            <a href="https://e2b.dev" target="_blank" rel="noreferrer" className="underline">
              e2b.dev
            </a>
            . Stored AES-256 encrypted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Msg text={e2bMsg} />
          {e2bConfigured ? (
            <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-4 py-2.5">
              <p className="flex items-center gap-2 text-sm">
                <Badge variant="success">On</Badge>
                E2B key configured — code execution is on
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() =>
                  confirm({
                    title: "Remove the E2B key?",
                    description: "Code execution will turn off until a new key is added.",
                    actionLabel: "Remove",
                    run: removeE2BKey,
                  })
                }
              >
                Remove
              </Button>
            </div>
          ) : (
            <form onSubmit={saveE2BKey} className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={e2bKeyValue}
                onChange={(e) => setE2bKeyValue(e.target.value)}
                placeholder="e2b_…"
                type="password"
                className="flex-1"
              />
              <Button type="submit" disabled={e2bBusy || !e2bKeyValue.trim()}>
                {e2bBusy && <Loader2 className="animate-spin" />}
                {e2bBusy ? "Verifying…" : "Save key"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Globe className="size-4" />
            </span>
            Website builder (Vercel + Cloudflare)
          </CardTitle>
          <CardDescription>
            Lets your agent generate Next.js websites, deploy previews to Vercel, and publish
            them live at <strong>your-site.veritask.site</strong>. Needs two API tokens, both
            stored AES-256 encrypted and verified before saving: a{" "}
            <a href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer" className="underline">
              Vercel token
            </a>{" "}
            (account → Settings → Tokens) and a{" "}
            <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" className="underline">
              Cloudflare token
            </a>{" "}
            with DNS:Edit on the veritask.site zone only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Msg text={siteMsg} />
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant={siteVercel ? "success" : "secondary"}>
              Vercel {siteVercel ? "connected" : "not set"}
            </Badge>
            <Badge variant={siteCloudflare ? "success" : "secondary"}>
              Cloudflare {siteCloudflare ? "connected" : "not set"}
            </Badge>
            {(siteVercel || siteCloudflare) && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() =>
                  confirm({
                    title: "Remove hosting tokens?",
                    description:
                      "Site generation still works, but deploying and publishing turn off until tokens are added again.",
                    actionLabel: "Remove",
                    run: removeSiteConfig,
                  })
                }
              >
                Remove all
              </Button>
            )}
          </div>
          <form onSubmit={saveSiteConfig} className="space-y-2">
            <Input
              value={vercelTokenValue}
              onChange={(e) => setVercelTokenValue(e.target.value)}
              placeholder={siteVercel ? "Vercel token — set (paste to replace)" : "Vercel API token"}
              type="password"
            />
            <Input
              value={vercelTeamValue}
              onChange={(e) => setVercelTeamValue(e.target.value)}
              placeholder="Vercel Team ID (optional — only for team accounts, starts team_…)"
            />
            <Input
              value={cfTokenValue}
              onChange={(e) => setCfTokenValue(e.target.value)}
              placeholder={siteCloudflare ? "Cloudflare token — set (paste to replace)" : "Cloudflare API token (DNS edit on veritask.site)"}
              type="password"
            />
            <Button
              type="submit"
              disabled={siteBusy || (!vercelTokenValue.trim() && !cfTokenValue.trim() && !vercelTeamValue.trim())}
            >
              {siteBusy && <Loader2 className="animate-spin" />}
              {siteBusy ? "Verifying…" : "Save tokens"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <KeyRound className="size-4" />
            </span>
            Test accounts (sign-up & login)
          </CardTitle>
          <CardDescription>
            Accounts your agent may use when testing sign-up/login flows or doing web tasks for
            you. Passwords are AES-256 encrypted and <strong>never shown in chat</strong> — the
            agent fills them through secure tokens, so they never pass through the conversation.
            Add accounts for sites you test, or generate a fresh identity for a sign-up.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Msg text={aMsg} />
          <div className="space-y-2">
            {accounts.length === 0 && (
              <p className="text-sm text-muted-foreground">No test accounts yet.</p>
            )}
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {a.site}
                    {a.generated && <Badge variant="secondary" className="ml-2">generated</Badge>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[a.label, a.email, a.username].filter(Boolean).join(" · ") || "—"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() =>
                    confirm({
                      title: "Delete this test account?",
                      description: `The agent will no longer be able to log in to ${a.site} with it.`,
                      actionLabel: "Delete",
                      run: () => removeAccount(a.id),
                    })
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          <form onSubmit={addAccount} className="space-y-2">
            <Input value={aSite} onChange={(e) => setASite(e.target.value)} placeholder="Site — e.g. app.example.com or https://example.com" />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input value={aLabel} onChange={(e) => setALabel(e.target.value)} placeholder="Label (optional)" />
              <Input value={aUsername} onChange={(e) => setAUsername(e.target.value)} placeholder="Username (if the site uses one)" />
              <Input value={aEmail} onChange={(e) => setAEmail(e.target.value)} placeholder="Email" type="email" />
              <Input value={aPassword} onChange={(e) => setAPassword(e.target.value)} placeholder="Password" type="password" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={aBusy || !aSite.trim() || !aPassword}>
                {aBusy && <Loader2 className="animate-spin" />}
                Save account
              </Button>
              <Button type="button" variant="secondary" disabled={aBusy || !aSite.trim()} onClick={generateAccount}>
                Generate identity instead
              </Button>
            </div>
          </form>
          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center">
            <p className="text-xs text-muted-foreground sm:w-56">
              Domain for generated emails. Use a domain whose inbox you control (or a catch-all)
              if sign-ups need email verification.
            </p>
            <Input value={aDomain} onChange={(e) => setADomain(e.target.value)} placeholder="example.com" className="flex-1" />
            <Button type="button" variant="outline" size="sm" onClick={saveDomain} className="shrink-0">
              Save domain
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Plug className="size-4" />
            </span>
            API connectors
          </CardTitle>
          <CardDescription>
            Save API keys for services your agent can call from chat (email, domains,
            anything with an HTTP API). Keys are AES-256 encrypted in Supabase, tested
            before saving, and never sent to your browser. Add them here — not in chat,
            so they never land in chat history.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Msg text={cMsg} />
          <form onSubmit={discoverService} className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={dService}
              onChange={(e) => setDService(e.target.value)}
              placeholder="Service name — e.g. Resend, Cloudflare, GitHub"
              className="flex-1"
            />
            <Button type="submit" variant="secondary" disabled={dBusy || !dService.trim()} className="shrink-0">
              {dBusy ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {dBusy ? "Looking up…" : "Auto-fill details"}
            </Button>
          </form>
          {dNote && <p className="text-xs text-muted-foreground">{dNote}</p>}
          <div className="space-y-2">
            {connectors.length === 0 && (
              <p className="text-sm text-muted-foreground">No connectors yet — add your first below.</p>
            )}
            {connectors.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.authType} · {c.baseUrl}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={c.enabled}
                    onCheckedChange={(v) => toggleConnector(c.id, v)}
                    aria-label={`Toggle ${c.name}`}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() =>
                      confirm({
                        title: "Delete this connector?",
                        description: `The connector “${c.name}” and its stored key will be deleted.`,
                        actionLabel: "Delete",
                        run: () => deleteConnector(c.id),
                      })
                    }
                    aria-label={`Delete ${c.name}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <form onSubmit={addConnector} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input
              value={cName}
              onChange={(e) => setCName(e.target.value)}
              placeholder="Name (e.g. resend)"
            />
            <Input
              value={cBaseUrl}
              onChange={(e) => setCBaseUrl(e.target.value)}
              placeholder="Base URL (https://api.example.com)"
            />
            <select value={cAuthType} onChange={(e) => setCAuthType(e.target.value)} className={selectClass}>
              {AUTH_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            {authFieldLabel ? (
              <Input
                value={cAuthField}
                onChange={(e) => setCAuthField(e.target.value)}
                placeholder={authFieldLabel}
              />
            ) : (
              <Input
                value={cTestPath}
                onChange={(e) => setCTestPath(e.target.value)}
                placeholder="Test path (optional, e.g. /v1/models)"
              />
            )}
            {cAuthType !== "none" && (
              <Input
                value={cKey}
                onChange={(e) => setCKey(e.target.value)}
                placeholder="API key / token"
                type="password"
              />
            )}
            {authFieldLabel && (
              <Input
                value={cTestPath}
                onChange={(e) => setCTestPath(e.target.value)}
                placeholder="Test path (optional)"
              />
            )}
            <Button
              type="submit"
              disabled={cBusy || !cName.trim() || !cBaseUrl.trim() || (cAuthType !== "none" && !cKey.trim())}
              className="sm:col-span-2"
            >
              {cBusy && <Loader2 className="animate-spin" />}
              {cBusy ? "Testing…" : "Save connector"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="size-4" />
            </span>
            Agent
          </CardTitle>
          <CardDescription>Default model and personality for new chats.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="model-select">Model</Label>
            <select id="model-select" value={model} onChange={(e) => setModel(e.target.value)} className={selectClass}>
              {MODELS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="system-prompt">System prompt</Label>
            <Textarea
              id="system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={4}
              placeholder="Leave empty for the default personality…"
            />
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={saveSettings}>Save</Button>
            {saved && (
              <span className="flex items-center gap-1.5 text-sm text-emerald-400">
                <CheckCircle2 className="size-4" /> Saved
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!confirmState} onOpenChange={(o) => !o && setConfirmState(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmState?.title}</DialogTitle>
            <DialogDescription>{confirmState?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmState(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                confirmState?.run();
                setConfirmState(null);
              }}
            >
              {confirmState?.actionLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
