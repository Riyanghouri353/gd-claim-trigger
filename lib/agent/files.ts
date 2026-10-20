import { getServiceClient } from "./supabase";

export interface AgentFileRow {
  id: string;
  name: string;
  mime: string;
  content: string;
  size: number;
  created_at: string;
}

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
  content: string
): Promise<{ id: string; path: string }> {
  const safeName = name.replace(/[^\w.\- ]+/g, "").slice(0, 120) || "file.txt";
  const ext = safeName.split(".").pop()?.toLowerCase() || "";
  const mime = MIME_BY_EXT[ext] || "text/plain";
  const { data, error } = await getServiceClient()
    .from("agent_files")
    .insert({ name: safeName, mime, content, size: content.length })
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
