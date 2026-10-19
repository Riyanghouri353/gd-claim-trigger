-- Riyan Agent schema. Run once in the Supabase SQL editor.
-- All tables have RLS enabled with NO public policies: only the
-- service_role key (used server-side) can read/write.

create table if not exists app_settings (
  key text primary key,
  value text not null
);

create table if not exists groq_keys (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  enc_key text not null,   -- AES-256-GCM ciphertext (hex)
  iv text not null,        -- hex
  tag text not null,       -- GCM auth tag (hex)
  disabled boolean not null default false,
  cooldown_until timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  title text,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_idx on messages(conversation_id, created_at);

alter table app_settings enable row level security;
alter table groq_keys enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
-- No policies created on purpose: service_role bypasses RLS, anon gets nothing.
