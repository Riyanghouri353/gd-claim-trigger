import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getServiceClient } from "@/lib/agent/supabase";
import { getSession } from "@/lib/agent/auth";

// Simple in-memory login throttling (resets on redeploy — fine for 1 user).
const attempts = new Map<string, { count: number; until: number }>();

export async function POST(req: Request) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec && rec.until > now) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in 15 minutes." },
      { status: 429 }
    );
  }

  const { password } = await req.json();
  const sb = getServiceClient();
  const { data }: { data: { value: string } | null } = await sb
    .from("app_settings")
    .select("value")
    .eq("key", "password_hash")
    .maybeSingle();
  if (!data) {
    return NextResponse.json({ error: "Not set up yet — visit /setup first" }, { status: 400 });
  }

  const ok = await bcrypt.compare(password || "", data.value);
  if (!ok) {
    const next = { count: (rec?.count ?? 0) + 1, until: 0 };
    if (next.count >= 8) next.until = now + 15 * 60 * 1000;
    attempts.set(ip, next);
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  attempts.delete(ip);

  const session = await getSession();
  session.loggedIn = true;
  await session.save();
  return NextResponse.json({ ok: true });
}
