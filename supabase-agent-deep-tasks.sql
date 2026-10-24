-- Deep tasks: long background jobs started from chat, reporting back into
-- the conversation. The engine runs detached from the chat request; the
-- 5-minute cron tick reaps stale runs and starts queued ones, so a server
-- restart never leaves a task silently stuck.
create table if not exists public.deep_tasks (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid,
  goal text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  plan jsonb not null default '[]'::jsonb,
  progress jsonb not null default '[]'::jsonb,
  result text,
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz
);

create index if not exists deep_tasks_status_idx on public.deep_tasks (status, created_at);
create index if not exists deep_tasks_conversation_idx on public.deep_tasks (conversation_id, created_at desc);

alter table public.deep_tasks enable row level security;
-- No public policies: service_role only, same as every other agent table.
