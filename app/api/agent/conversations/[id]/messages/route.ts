import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { getServiceClient } from "@/lib/agent/supabase";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const { data, error } = await getServiceClient()
    .from("messages")
    .select("id,role,content,created_at")
    .eq("conversation_id", id)
    .order("created_at");
  if (error) return NextResponse.json({ error: "Database error" }, { status: 500 });
  // Shape into UIMessage-compatible objects for useChat
  const messages = (data ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    parts: [{ type: "text", text: m.content }],
  }));
  return NextResponse.json({ messages });
}
