import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { getServiceClient } from "@/lib/agent/supabase";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const { error } = await getServiceClient().from("groq_keys").delete().eq("id", id);
  if (error) return NextResponse.json({ error: "Database error" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
