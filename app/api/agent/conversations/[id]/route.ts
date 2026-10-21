import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { getServiceClient } from "@/lib/agent/supabase";
import { deleteConversationFiles } from "@/lib/agent/files";
import { browserClose } from "@/lib/agent/browser";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // Purge the chat's files (screenshots in Supabase Storage + generated
  // files) so deleting a chat frees its storage, and close any live
  // browser session bound to it.
  await deleteConversationFiles(id).catch(() => {});
  await browserClose(id).catch(() => {});
  const { error } = await getServiceClient().from("conversations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: "Database error" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
