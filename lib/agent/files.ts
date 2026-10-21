import { getServiceClient } from "./supabase";

export interface AgentFileRow {
  id: string;
  name: string;
  mime: string;
  content: string;
  size: number;
  storage_path: string | null;
  conversation_id: string | null;
  created_at: string;
}

export const AGENT_BUCKET = "agent-files";

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  svg: "image/svg+xml",
  js: "text/javascript",
  ts: "text/plain",
  py: "text/plain",
  css: "text/css",
};

/** Store a text file the agent generated; returns its id + download path. */
export async function createAgentFile(
  name: string,
  content: string,
  conversationId?: string | null
): Promise<{ id: string; path: string }> {
  const safeName = name.replace(/[^\w.\- ]+/g, "").slice(0, 120) || "file.txt";
  const ext = safeName.split(".").pop()?.toLowerCase() || "";
  const mime = MIME_BY_EXT[ext] || "text/plain";
  const { data, error } = await getServiceClient()
    .from("agent_files")
    .insert({
      name: safeName,
      mime,
      content,
      size: content.length,
      conversation_id: conversationId ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error("Could not store file");
  return { id: data.id, path: `/api/agent/files/${data.id}` };
}

export async function getAgentFile(id: string): Promise<AgentFileRow | null> {
  const { data } = await getServiceClient()
    .from("agent_files")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return (data as AgentFileRow) ?? null;
}

/**
 * Store an image (e.g. a browser screenshot) in Supabase Storage — binary in
 * the `agent-files` bucket, only metadata in the DB row. The files route
 * serves it back through the session gate. Linked to its conversation so
 * deleting the chat purges the object and frees the storage.
 */
export async function createAgentImageFile(
  name: string,
  base64: string,
  mime = "image/png",
  conversationId?: string | null
): Promise<{ id: string; path: string }> {
  const sb = getServiceClient();
  const id = crypto.randomUUID();
  const ext = mime === "image/jpeg" ? "jpg" : "png";
  const storagePath = `images/${id}.${ext}`;
  const bytes = Buffer.from(base64, "base64");
  const up = await sb.storage
    .from(AGENT_BUCKET)
    .upload(storagePath, bytes, { contentType: mime, upsert: false });
  if (up.error) throw new Error(`Could not store image: ${up.error.message}`);
  const { error } = await sb.from("agent_files").insert({
    id,
    name,
    mime,
    content: "",
    size: bytes.length,
    storage_path: storagePath,
    conversation_id: conversationId ?? null,
  });
  if (error) {
    await sb.storage.from(AGENT_BUCKET).remove([storagePath]).catch(() => {});
    throw new Error("Could not store image");
  }
  return { id, path: `/api/agent/files/${id}` };
}

/** Delete every file (rows + storage objects) belonging to a conversation. */
export async function deleteConversationFiles(conversationId: string): Promise<void> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("agent_files")
    .select("storage_path")
    .eq("conversation_id", conversationId);
  const paths = (data ?? [])
    .map((r: any) => r.storage_path)
    .filter((p: string | null): p is string => !!p);
  if (paths.length) {
    await sb.storage.from(AGENT_BUCKET).remove(paths).catch(() => {});
  }
  await sb.from("agent_files").delete().eq("conversation_id", conversationId);
}
