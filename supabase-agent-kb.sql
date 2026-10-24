-- Knowledge base (RAG) for Riyan's personal agent.
-- Retrieval is Postgres full-text search + trigram fuzzy matching: no new
-- API keys, no new vendors. An embeddings column can be added later as
-- phase 2 when a Gemini key exists (text-embedding-004).
create extension if not exists pg_trgm;

create table if not exists public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_type text not null check (source_type in ('text', 'url', 'file', 'chat')),
  source_url text,
  file_name text,
  chunk_count int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.kb_documents (id) on delete cascade,
  chunk_index int not null,
  content text not null,
  content_tsv tsvector generated always as (to_tsvector('english', content)) stored
);

create index if not exists kb_chunks_document_idx on public.kb_chunks (document_id, chunk_index);
create index if not exists kb_chunks_tsv_idx on public.kb_chunks using gin (content_tsv);
create index if not exists kb_chunks_trgm_idx on public.kb_chunks using gin (content gin_trgm_ops);

alter table public.kb_documents enable row level security;
alter table public.kb_chunks enable row level security;
-- No public policies: service_role only, same as every other agent table.

-- Ranked retrieval: full-text rank wins, trigram similarity catches fuzzy
-- wording, and a title match boosts. Returns the best chunks with scores.
create or replace function public.search_kb_chunks(p_query text, p_limit int default 8)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_title text,
  chunk_index int,
  content text,
  score double precision
)
language sql stable as $$
  with q as (select plainto_tsquery('english', p_query) as tsq)
  select
    c.id,
    c.document_id,
    d.title,
    c.chunk_index,
    c.content,
    (
      ts_rank_cd(c.content_tsv, q.tsq) * 10
      + similarity(c.content, p_query) * 5
      + case when d.title ilike '%' || p_query || '%' then 2 else 0 end
    ) as score
  from public.kb_chunks c
  join public.kb_documents d on d.id = c.document_id
  cross join q
  where c.content_tsv @@ q.tsq or similarity(c.content, p_query) > 0.08
  order by score desc
  limit p_limit;
$$;
