-- Load test history: one row per finished test, so results survive the chat.
create table if not exists public.load_tests (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  mode text not null check (mode in ('burst', 'sustained')),
  requested int not null,
  rps int,
  duration_sec int,
  concurrency int not null,
  total int not null,
  succeeded int not null,
  failed int not null,
  error_rate numeric not null,
  status_counts jsonb not null default '{}'::jsonb,
  errors jsonb not null default '{}'::jsonb,
  latency_ms jsonb not null default '{}'::jsonb,
  actual_rps numeric not null,
  verdict text not null,
  created_at timestamptz not null default now()
);

create index if not exists load_tests_created_idx on public.load_tests (created_at desc);

alter table public.load_tests enable row level security;
-- No public policies: service_role only, same as every other agent table.
