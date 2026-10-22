"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Globe, Inbox, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import ThemeToggle from "../theme-toggle";

interface Site {
  id: string;
  name: string;
  slug: string;
  status: string;
  preview_url: string | null;
  live_url: string | null;
  updated_at: string;
  submissions?: { total: number; unread: number };
}

interface Submission {
  id: string;
  form_name: string;
  data: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

export default function SitesClient() {
  const router = useRouter();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inboxFor, setInboxFor] = useState<string | null>(null);
  const [subs, setSubs] = useState<Submission[]>([]);

  async function load() {
    const res = await fetch("/api/agent/sites");
    if (res.status === 401) {
      router.push("/agent/login");
      return;
    }
    if (res.ok) setSites((await res.json()).sites ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(id: string) {
    setBusyId(id);
    await fetch(`/api/agent/sites/${id}`, { method: "DELETE" });
    setBusyId(null);
    setConfirmId(null);
    load();
  }

  async function toggleInbox(s: Site) {
    if (inboxFor === s.id) {
      setInboxFor(null);
      return;
    }
    const res = await fetch(`/api/agent/sites/${s.id}/submissions?limit=50`);
    if (res.ok) {
      setSubs((await res.json()).submissions ?? []);
      setInboxFor(s.id);
    }
  }

  async function markRead(sub: Submission) {
    if (!inboxFor) return;
    await fetch(`/api/agent/sites/${inboxFor}/submissions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sub.id, read: !sub.is_read }),
    }).catch(() => {});
    const res = await fetch(`/api/agent/sites/${inboxFor}/submissions?limit=50`);
    if (res.ok) setSubs((await res.json()).submissions ?? []);
    load();
  }

  async function deleteSub(siteId: string, subId: string) {
    await fetch(`/api/agent/sites/${siteId}/submissions?sub=${subId}`, { method: "DELETE" });
    const res = await fetch(`/api/agent/sites/${siteId}/submissions?limit=50`);
    if (res.ok) setSubs((await res.json()).submissions ?? []);
    load();
  }

  return (
    <div className="relative mx-auto w-full max-w-3xl px-4 py-8">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <button
        onClick={() => router.push("/agent")}
        className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to chat
      </button>

      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <Globe className="size-6 text-primary" /> My websites
      </h1>
      <p className="mb-8 mt-1 text-sm text-muted-foreground">
        Websites your agent built. Ask in chat to create or edit one, deploy a preview, or
        publish it live at its veritask.site subdomain.
      </p>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : sites.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No websites yet. In chat, try: “Build a website for my bakery”.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {sites.map((s) => (
            <Card key={s.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {s.name}
                  <Badge variant={s.status === "live" ? "success" : "secondary"}>
                    {s.status}
                  </Badge>
                  <span className="text-xs font-normal text-muted-foreground">
                    {s.slug}.veritask.site
                  </span>
                </CardTitle>
                <CardDescription>
                  Updated {new Date(s.updated_at).toLocaleString()}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                {s.preview_url && (
                  <a href={s.preview_url} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="sm">
                      Open preview ↗
                    </Button>
                  </a>
                )}
                {s.live_url && s.status === "live" && (
                  <a href={s.live_url} target="_blank" rel="noopener noreferrer">
                    <Button size="sm">Open live site ↗</Button>
                  </a>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toggleInbox(s)}
                >
                  <Inbox className="size-4" />
                  Submissions ({s.submissions?.total ?? 0})
                  {(s.submissions?.unread ?? 0) > 0 && (
                    <Badge variant="destructive" className="ml-1">
                      {s.submissions?.unread} new
                    </Badge>
                  )}
                </Button>
                <span className="flex-1" />
                {confirmId === s.id ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      Delete site, Vercel project + DNS?
                    </span>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busyId === s.id}
                      onClick={() => remove(s.id)}
                    >
                      {busyId === s.id && <Loader2 className="animate-spin" />}
                      Confirm delete
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmId(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmId(s.id)}
                  >
                    <Trash2 className="size-4" /> Delete
                  </Button>
                )}
                </div>
                {inboxFor === s.id && (
                  <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                    {subs.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        No submissions yet — they appear here when a visitor sends one of
                        the site's forms.
                      </p>
                    )}
                    {subs.map((sub) => (
                      <div
                        key={sub.id}
                        className={`rounded-md border bg-background p-3 text-sm ${sub.is_read ? "opacity-60" : ""}`}
                      >
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="secondary">{sub.form_name}</Badge>
                          {new Date(sub.created_at).toLocaleString()}
                          {!sub.is_read && <Badge variant="success">new</Badge>}
                          <span className="flex-1" />
                          <button
                            className="underline underline-offset-2 hover:text-foreground"
                            onClick={() => markRead(sub)}
                          >
                            Mark {sub.is_read ? "unread" : "read"}
                          </button>
                          <button
                            className="text-destructive underline underline-offset-2"
                            onClick={() => deleteSub(s.id, sub.id)}
                          >
                            Delete
                          </button>
                        </div>
                        <dl className="mt-2 space-y-1">
                          {Object.entries(sub.data).map(([k, v]) => (
                            <div key={k} className="flex gap-2">
                              <dt className="min-w-24 font-medium capitalize">{k}</dt>
                              <dd className="whitespace-pre-wrap break-words">{String(v)}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
