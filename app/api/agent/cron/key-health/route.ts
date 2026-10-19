import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/agent/supabase";
import { decryptSecret } from "@/lib/agent/crypto";

/**
 * Nightly key health check (Vercel Cron, see vercel.json).
 * Pings every stored key against Groq; disables 401s, clears stale cooldowns.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sb = getServiceClient();
  const { data: keys } = await sb.from("groq_keys").select("*");
  const report: { label: string; ok: boolean; note: string }[] = [];

  for (const k of keys ?? []) {
    let apiKey: string;
    try {
      apiKey = decryptSecret({ enc: k.enc_key, iv: k.iv, tag: k.tag });
    } catch {
      report.push({ label: k.label, ok: false, note: "decrypt failed" });
      continue;
    }
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.status === 401) {
        await sb.from("groq_keys").update({ disabled: true }).eq("id", k.id);
        report.push({ label: k.label, ok: false, note: "401 — disabled" });
      } else if (!res.ok) {
        report.push({ label: k.label, ok: false, note: `Groq ${res.status}` });
      } else {
        await sb.from("groq_keys").update({ disabled: false, cooldown_until: null }).eq("id", k.id);
        report.push({ label: k.label, ok: true, note: "healthy" });
      }
    } catch {
      report.push({ label: k.label, ok: false, note: "network error" });
    }
  }

  return NextResponse.json({ checked: report.length, report });
}
