"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  FileText,
  Globe,
  Link2,
  Loader2,
  MessageSquare,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import ThemeToggle from "../theme-toggle";

interface KbDoc {
  id: string;
  title: string;
  source_type: string;
  source_url: string | null;
  file_name: string | null;
  chunk_count: number;
  created_at: string;
}

interface KbHit {
  chunk_id: string;
  document_id: string;
  document_title: string;
  chunk_index: number;
  content: string;
  score: number;
}

const SOURCE_LABEL: Record<string, string> = {
  text: "Pasted text",
  url: "Web page",
  file: "Uploaded file",
  chat: "Saved from chat",
};

function SourceIcon({ t }: { t: string }) {
  if (t === "url") return <Globe className="size-4" />;
  if (t === "file") return <FileText className="size-4" />;
  if (t === "chat") return <MessageSquare className="size-4" />;
  return <BookOpen className="size-4" />;
}

export default function KnowledgeClient() {
  const router = useRouter();
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [stats, setStats] = useState<{ documents: number; chunks: number; last_updated: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KbHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/agent/kb");
    if (res.status === 401) {
      router.push("/agent/login");
      return;
    }
    if (res.ok) {
      const j = await res.json();
      setDocs(j.documents ?? []);
      setStats(j.stats ?? null);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setHits(null);
    const res = await fetch(`/api/agent/kb?q=${encodeURIComponent(query.trim())}`);
    if (res.ok) setHits((await res.json()).hits ?? []);
    setSearching(false);
  }

  async function addText(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    setAddBusy(true);
    setMsg("");
    const res = await fetch("/api/agent/kb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim(), content }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      setMsg(`Saved “${j.document.title}” — ${j.chunks} chunks. Your agent can now answer from it.`);
      setTitle("");
      setContent("");
      load();
    } else {
      setMsg(j.error || "Could not save the document.");
    }
    setAddBusy(false);
  }

  async function addUrl(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setAddBusy(true);
    setMsg("");
    const res = await fetch("/api/agent/kb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim(), url: url.trim() }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      setMsg(`Saved “${j.document.title}” from the web — ${j.chunks} chunks.`);
      setTitle("");
      setUrl("");
      load();
    } else {
      setMsg(j.error || "Could not read that URL.");
    }
    setAddBusy(false);
  }

  async function uploadFile(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setUploadBusy(true);
    setMsg("");
    const form = new FormData();
    form.append("file", file);
    if (title.trim()) form.append("title", title.trim());
    const res = await fetch("/api/agent/kb/upload", { method: "POST", body: form });
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      setMsg(`Saved “${j.document.title}” — ${j.chunks} chunks.`);
      setFile(null);
      setTitle("");
      (document.getElementById("kb-file") as HTMLInputElement | null)?.value &&
        (((document.getElementById("kb-file") as HTMLInputElement).value = ""));
      load();
    } else {
      setMsg(j.error || "Could not upload the file.");
    }
    setUploadBusy(false);
  }

  async function removeDoc(id: string) {
    setBusyId(id);
    await fetch(`/api/agent/kb?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setConfirmId(null);
    setBusyId(null);
    load();
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Knowledge base</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your agent&apos;s library. Anything saved here becomes something it can answer from — with sources.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle />
          <Button variant="ghost" onClick={() => router.push("/agent")}>
            <ArrowLeft />
            Back to chat
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="shadow-sm">
          <CardContent className="pt-5">
            <p className="text-2xl font-bold">{loading ? "…" : stats?.documents ?? 0}</p>
            <p className="text-xs text-muted-foreground">Documents</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardContent className="pt-5">
            <p className="text-2xl font-bold">{loading ? "…" : stats?.chunks ?? 0}</p>
            <p className="text-xs text-muted-foreground">Searchable chunks</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardContent className="pt-5">
            <p className="truncate text-sm font-medium">
              {stats?.last_updated ? new Date(stats.last_updated).toLocaleDateString() : "—"}
            </p>
            <p className="text-xs text-muted-foreground">Last added</p>
          </CardContent>
        </Card>
      </div>

      {/* Search — the retrieval demo */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Search className="size-4" />
            </span>
            Search your knowledge
          </CardTitle>
          <CardDescription>
            Ask anything — this runs the same ranked search the chat uses, so you can see exactly what it finds.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={runSearch} className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. What are the bakery prices?"
              className="flex-1"
            />
            <Button type="submit" disabled={searching || !query.trim()}>
              {searching && <Loader2 className="animate-spin" />}
              Search
            </Button>
          </form>
          {hits !== null && (
            <div className="space-y-2">
              {hits.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Nothing found — try different words, or add the document first below.
                </p>
              )}
              {hits.map((h) => (
                <div key={h.chunk_id} className="rounded-xl border bg-muted/40 px-4 py-3">
                  <p className="flex items-center justify-between gap-2 text-sm font-medium">
                    <span className="truncate">{h.document_title}</span>
                    <Badge variant="secondary" className="shrink-0">
                      {Math.round(Math.min(h.score, 10) * 10)}% match
                    </Badge>
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{h.content.slice(0, 400)}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <BookOpen className="size-4" />
            </span>
            Add to the knowledge base
          </CardTitle>
          <CardDescription>
            Paste text, fetch a web page, or upload a file (.txt, .md, .csv, .json, .pdf — up to 10 MB).
            Long documents are split into searchable chunks automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {msg && <p className="rounded-xl bg-muted/50 px-3.5 py-2.5 text-sm">{msg}</p>}
          <div className="space-y-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title (optional — used for all three ways below)"
            />
          </div>
          <form onSubmit={addText} className="space-y-2">
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              placeholder="Paste text here — notes, prices, procedures, anything you want the agent to know…"
            />
            <Button type="submit" disabled={addBusy || !content.trim()}>
              {addBusy && <Loader2 className="animate-spin" />}
              Save pasted text
            </Button>
          </form>
          <form onSubmit={addUrl} className="flex flex-col gap-2 border-t pt-4 sm:flex-row">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://… — fetch a page into the knowledge base"
              className="flex-1"
            />
            <Button type="submit" variant="secondary" disabled={addBusy || !url.trim()} className="shrink-0">
              <Link2 />
              Fetch from web
            </Button>
          </form>
          <form onSubmit={uploadFile} className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center">
            <Input
              id="kb-file"
              type="file"
              accept=".txt,.md,.markdown,.csv,.json,.pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="flex-1"
            />
            <Button type="submit" variant="secondary" disabled={uploadBusy || !file} className="shrink-0">
              {uploadBusy && <Loader2 className="animate-spin" />}
              <Upload />
              Upload file
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Documents */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <FileText className="size-4" />
            </span>
            Documents
          </CardTitle>
          <CardDescription>
            Everything the agent can answer from. Deleting a document removes all its chunks at once.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!loading && docs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing saved yet — add your first document above, or tell the agent in chat to remember something
              in the knowledge base.
            </p>
          )}
          {docs.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 rounded-xl border bg-muted/40 px-4 py-2.5">
              <div className="min-w-0">
                <p className="flex items-center gap-2 truncate text-sm font-medium">
                  <SourceIcon t={d.source_type} />
                  <span className="truncate">{d.title}</span>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {SOURCE_LABEL[d.source_type] ?? d.source_type} · {d.chunk_count} chunks ·{" "}
                  {new Date(d.created_at).toLocaleDateString()}
                  {d.source_url ? ` · ${d.source_url}` : d.file_name ? ` · ${d.file_name}` : ""}
                </p>
              </div>
              {confirmId === d.id ? (
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="destructive" disabled={busyId === d.id} onClick={() => removeDoc(d.id)}>
                    Confirm delete
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmId(null)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() => setConfirmId(d.id)}
                >
                  <Trash2 className="size-4" />
                  Delete
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
