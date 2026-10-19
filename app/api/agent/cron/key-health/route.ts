import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/agent/supabase";
import { decryptSecret } from "@/lib/agent/crypto";
import { testGeminiKey, testLovableKey } from "@/lib/agent/keys";

/**
 * Nightly key health check.
 * Pings every stored Groq + Gemini key; disables dead keys, clears stale cooldowns.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sb = getServiceClient();
  const report: { provider: string; label: string; ok: boolean; note: string }[] = [];

  const { data: groqKeys } = await sb.from("groq_keys").select("*");
  for (const k of groqKeys ?? []) {
    let apiKey: string;
    try {
      apiKey = decryptSecret({ enc: k.enc_key, iv: k.iv, tag: k.tag });
    } catch {
      report.push({ provider: "groq", label: k.label, ok: false, note: "decrypt failed" });
      continue;
    }
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.status === 401) {
        await sb.from("groq_keys").update({ disabled: true }).eq("id", k.id);
        report.push({ provider: "groq", label: k.label, ok: false, note: "401 — disabled" });
      } else if (!res.ok) {
        report.push({ provider: "groq", label: k.label, ok: false, note: `Groq ${res.status}` });
      } else {
        await sb.from("groq_keys").update({ disabled: false, cooldown_until: null }).eq("id", k.id);
        report.push({ provider: "groq", label: k.label, ok: true, note: "healthy" });
      }
    } catch {
      report.push({ provider: "groq", label: k.label, ok: false, note: "network error" });
    }
  }

  const { data: geminiKeys } = await sb.from("gemini_keys").select("*");
  for (const k of geminiKeys ?? []) {
    let apiKey: string;
    try {
      apiKey = decryptSecret({ enc: k.enc_key, iv: k.iv, tag: k.tag });
    } catch {
      report.push({ provider: "gemini", label: k.label, ok: false, note: "decrypt failed" });
      continue;
    }
    const check = await testGeminiKey(apiKey);
    if (!check.ok) {
      if (check.error === "Invalid key") {
        await sb.from("gemini_keys").update({ disabled: true }).eq("id", k.id);
        report.push({ provider: "gemini", label: k.label, ok: false, note: "invalid — disabled" });
      } else {
        report.push({ provider: "gemini", label: k.label, ok: false, note: check.error || "failed" });
      }
    } else {
      await sb.from("gemini_keys").update({ disabled: false, cooldown_until: null }).eq("id", k.id);
      report.push({ provider: "gemini", label: k.label, ok: true, note: "healthy" });
    }
  }

  const { data: lovableKeys } = await sb.from("lovable_keys").select("*");
  for (const k of lovableKeys ?? []) {
    let apiKey: string;
    try {
      apiKey = decryptSecret({ enc: k.enc_key, iv: k.iv, tag: k.tag });
    } catch {
      report.push({ provider: "lovable", label: k.label, ok: false, note: "decrypt failed" });
      continue;
    }
    const check = await testLovableKey(apiKey);
    if (!check.ok) {
      if (check.error === "Invalid key") {
        await sb.from("lovable_keys").update({ disabled: true }).eq("id", k.id);
        report.push({ provider: "lovable", label: k.label, ok: false, note: "invalid — disabled" });
      } else {
        report.push({ provider: "lovable", label: k.label, ok: false, note: check.error || "failed" });
      }
    } else {
      await sb.from("lovable_keys").update({ disabled: false, cooldown_until: null }).eq("id", k.id);
      report.push({ provider: "lovable", label: k.label, ok: true, note: "healthy" });
    }
  }

  return NextResponse.json({ checked: report.length, report });
}
