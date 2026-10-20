import { getServiceClient } from "./supabase";

export interface MemoryRow {
  id: string;
  content: string;
  created_at: string;
}

/** Most recent memories, newest first. */
export async function listMemories(limit = 100): Promise<MemoryRow[]> {
  const { data } = await getServiceClient()
    .from("memories")
    .select("id,content,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as MemoryRow[];
}

/** Save a fact (exact duplicates are skipped). Returns true if stored. */
export async function addMemory(content: string): Promise<boolean> {
  const text = content.trim().slice(0, 500);
  if (!text) return false;
  const sb = getServiceClient();
  const { data } = await sb.from("memories").select("id").eq("content", text).limit(1);
  if (data && data.length > 0) return false;
  const { error } = await sb.from("memories").insert({ content: text });
  return !error;
}

export async function deleteMemory(id: string): Promise<void> {
  await getServiceClient().from("memories").delete().eq("id", id);
}
