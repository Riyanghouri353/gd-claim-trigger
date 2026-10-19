import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { getServiceClient } from "@/lib/agent/supabase";
import { decryptSecret } from "@/lib/agent/crypto";
import { testGeminiKey, type GroqKeyRow } from "@/lib/agent/keys";

export const dynamic = "force-dynamic";

/** Live-test a stored key against Google */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const sb = getServiceClient();
  const { data }: { data: GroqKeyRow | null } = await sb.from("gemini_keys").select("*").eq("id", id).maybeSingle();
  if (!data) return NextResponse.json({ error: "Key not found" }, { status: 404 });

  let apiKey: string;
  try {
    apiKey = decryptSecret({ enc: data.enc_key, iv: data.iv, tag: data.tag });
  } catch {
    return NextResponse.json({ error: "Decryption failed — is VAULT_KEY correct?" }, { status: 500 });
  }

  const check = await testGeminiKey(apiKey);
  if (!check.ok) {
    if (check.error === "Invalid key") {
      await sb.from("gemini_keys").update({ disabled: true }).eq("id", id);
      return NextResponse.json({ ok: false, error: "Invalid key — disabled" });
    }
    return NextResponse.json({ ok: false, error: check.error });
  }
  await sb.from("gemini_keys").update({ disabled: false, cooldown_until: null }).eq("id", id);
  return NextResponse.json({ ok: true });
}
