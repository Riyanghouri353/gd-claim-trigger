"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Globe, Loader2, Trash2 } from "lucide-react";
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
}

export default function SitesClient() {
  const router = useRouter();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
              <CardContent className="flex flex-wrap items-center gap-2">
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
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
