import { getServiceClient } from "./supabase";

export interface KbDocument {
  id: string;
  title: string;
  source_type: "text" | "url" | "file" | "chat";
  source_url: string | null;
  file_name: string | null;
  chunk_count: number;
  created_at: string;
}

export interface KbChunkHit {
  chunk_id: string;
  document_id: string;
  document_title: string;
  chunk_index: number;
  content: string;
  score: number;
}

export interface KbStats {
  documents: number;
  chunks: number;
  last_updated: string | null;
}

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS_PER_DOC = 500;
const MAX_CONTENT_CHARS = 200_000;

/** Split text into overlapping chunks on paragraph boundaries. */
export function chunkText(content: string): string[] {
  const text = content.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!text) return [];
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  const pushHardSplit = (block: string) => {
    // A single paragraph longer than the chunk size: slice it with overlap.
    let start = 0;
    while (start < block.length) {
      chunks.push(block.slice(start, start + CHUNK_SIZE));
      if (start + CHUNK_SIZE >= block.length) break;
      start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
  };
  let cur = "";
  for (const p of paragraphs) {
    if (p.length > CHUNK_SIZE) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      pushHardSplit(p);
      continue;
    }
    if (!cur) {
      cur = p;
    } else if (cur.length + 2 + p.length <= CHUNK_SIZE) {
      cur += "\n\n" + p;
    } else {
      chunks.push(cur);
      cur = cur.slice(-CHUNK_OVERLAP) + "\n\n" + p;
      if (cur.length > CHUNK_SIZE) cur = p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.slice(0, MAX_CHUNKS_PER_DOC);
}

export async function ingestDocument(input: {
  title: string;
  content: string;
  source_type: KbDocument["source_type"];
  source_url?: string | null;
  file_name?: string | null;
}): Promise<{ document: KbDocument; chunks: number }> {
  const title = input.title.trim().slice(0, 200) || "Untitled document";
  const content = input.content.trim().slice(0, MAX_CONTENT_CHARS);
  const chunks = chunkText(content);
  if (chunks.length === 0) throw new Error("Nothing to save — the document is empty.");
  const sb = getServiceClient();
  const { data: doc, error: docErr } = await sb
    .from("kb_documents")
    .insert({
      title,
      source_type: input.source_type,
      source_url: input.source_url ?? null,
      file_name: input.file_name ?? null,
      chunk_count: 0,
    })
    .select("id,title,source_type,source_url,file_name,chunk_count,created_at")
    .single();
  if (docErr || !doc) throw new Error(docErr?.message || "Could not save the document.");
  const { error: chunkErr } = await sb
    .from("kb_chunks")
    .insert(chunks.map((c, i) => ({ document_id: doc.id, chunk_index: i, content: c })));
  if (chunkErr) {
    await sb.from("kb_documents").delete().eq("id", doc.id);
    throw new Error(chunkErr.message);
  }
  await sb.from("kb_documents").update({ chunk_count: chunks.length }).eq("id", doc.id);
  return { document: { ...(doc as KbDocument), chunk_count: chunks.length }, chunks: chunks.length };
}

/**
 * Ranked retrieval. Primary path is the Postgres RPC (full-text rank +
 * trigram similarity + title boost). If the function is ever missing, the
 * fallback scores keyword overlap in code so search still works.
 */
export async function searchKnowledge(query: string, limit = 8): Promise<KbChunkHit[]> {
  const q = query.trim().slice(0, 500);
  if (!q) return [];
  const sb = getServiceClient();
  try {
    const { data, error } = await sb.rpc("search_kb_chunks", { p_query: q, p_limit: limit });
    if (!error && data) return (data as KbChunkHit[]).slice(0, limit);
  } catch {
    /* fall through to keyword fallback */
  }
  const words = q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .slice(0, 8);
  if (words.length === 0) return [];
  const orFilter = words.map((w) => `content.ilike.%${w}%`).join(",");
  const { data } = await sb
    .from("kb_chunks")
    .select("id,document_id,chunk_index,content")
    .or(orFilter)
    .limit(200);
  const docs = new Map<string, string>();
  const scored: KbChunkHit[] = [];
  for (const row of data ?? []) {
    if (!docs.has(row.document_id)) {
      const { data: d } = await sb
        .from("kb_documents")
        .select("title")
        .eq("id", row.document_id)
        .single();
      docs.set(row.document_id, (d as { title: string } | null)?.title ?? "Untitled");
    }
    const hay = row.content.toLowerCase();
    const matched = words.filter((w) => hay.includes(w)).length;
    if (matched > 0) {
      scored.push({
        chunk_id: row.id,
        document_id: row.document_id,
        document_title: docs.get(row.document_id) ?? "Untitled",
        chunk_index: row.chunk_index,
        content: row.content,
        score: matched,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function listDocuments(limit = 100): Promise<KbDocument[]> {
  const { data } = await getServiceClient()
    .from("kb_documents")
    .select("id,title,source_type,source_url,file_name,chunk_count,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as KbDocument[];
}

export async function deleteDocument(id: string): Promise<void> {
  // Chunks cascade via the foreign key.
  await getServiceClient().from("kb_documents").delete().eq("id", id);
}

export async function getKbStats(): Promise<KbStats> {
  const sb = getServiceClient();
  const { count: docCount } = await sb
    .from("kb_documents")
    .select("id", { count: "exact", head: true });
  const { count: chunkCount } = await sb
    .from("kb_chunks")
    .select("id", { count: "exact", head: true });
  const { data: latest } = await sb
    .from("kb_documents")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  return {
    documents: docCount ?? 0,
    chunks: chunkCount ?? 0,
    last_updated: (latest?.[0] as { created_at: string } | undefined)?.created_at ?? null,
  };
}
