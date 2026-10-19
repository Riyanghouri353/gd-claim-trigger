import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { getServiceClient } from "@/lib/agent/supabase";

export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data, error } = await getServiceClient()
    .from("conversations")
    .select("id,title,created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: "Database error" }, { status: 500 });
  return NextResponse.json({ conversations: data });
}

export async function POST() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data }: { data: { id: string } | null } = await getServiceClient()
    .from("conversations")
    .insert({ title: "New chat" })
    .select("id")
    .single();
  if (!data) return NextResponse.json({ error: "Database error" }, { status: 500 });
  return NextResponse.json({ id: data.id });
}
