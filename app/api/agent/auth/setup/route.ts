import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getServiceClient } from "@/lib/agent/supabase";

export async function GET() {
  const sb = getServiceClient();
  const { data }: { data: { value: string } | null } = await sb
    .from("app_settings")
    .select("value")
    .eq("key", "password_hash")
    .maybeSingle();
  return NextResponse.json({ setupDone: !!data });
}

export async function POST(req: Request) {
  const { password } = await req.json();
  if (!password || password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }
  const sb = getServiceClient();
  const { data }: { data: { value: string } | null } = await sb
    .from("app_settings")
    .select("value")
    .eq("key", "password_hash")
    .maybeSingle();
  if (data) {
    return NextResponse.json({ error: "Already set up" }, { status: 400 });
  }
  const hash = await bcrypt.hash(password, 12);
  const { error } = await sb.from("app_settings").upsert({ key: "password_hash", value: hash });
  if (error) {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
