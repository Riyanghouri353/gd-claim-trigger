import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { getServiceClient } from "@/lib/agent/supabase";
import { encryptSecret } from "@/lib/agent/crypto";
import { testGeminiKey } from "@/lib/agent/keys";

export const dynamic = "force-dynamic";

/** List keys (masked) */
export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sb = getServiceClient();
  const { data, error } = await sb
    .from("gemini_keys")
    .select("id,label,disabled,cooldown_until,last_used_at,created_at")
    .order("created_at");
  if (error) return NextResponse.json({ error: "Database error" }, { status: 500 });
  return NextResponse.json({ keys: data });
}

/** Add a key (tested against Google before saving) */
export async function POST(req: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { label, key } = await req.json();
  if (!label?.trim() || !key?.trim()) {
    return NextResponse.json({ error: "Label and key are required" }, { status: 400 });
  }
  const check = await testGeminiKey(key.trim());
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }
  const { enc, iv, tag } = encryptSecret(key.trim());
  const sb = getServiceClient();
  const { error } = await sb.from("gemini_keys").insert({
    label: label.trim(),
    enc_key: enc,
    iv,
    tag,
  });
  if (error) return NextResponse.json({ error: "Database error" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
