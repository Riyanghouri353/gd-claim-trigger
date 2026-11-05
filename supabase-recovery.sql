-- Wallet key recovery tool — run once in the Supabase dashboard → SQL editor.
-- (Already applied to project jmayjkfhmjqcxzsjyzyw on 2026-11-05; kept in the
-- repo so the schema is documented and reproducible.)
--
-- SECURITY: RLS is enabled with NO public policies, so only the service_role
-- key (used server-side by the app) can read. Templates and found private
-- keys are stored AES-256-GCM ENCRYPTED (lib/crypto.ts, PROJECT_KEY on
-- Render) — the columns never hold plaintext keys.

create table if not exists recovery_jobs (
  id uuid primary key default gen_random_uuid(),
  encrypted_template text not null,
  unknown_count int not null,
  total_combinations numeric not null,
  threshold_usdt numeric not null default 0.1,
  checked_count numeric not null default 0,
  found_count int not null default 0,
  rate_per_sec numeric not null default 0,
  status text not null default 'running', -- running | stopped | done | error
  last_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists recovery_hits (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references recovery_jobs(id),
  address text not null,
  encrypted_key text not null,
  usdt_balance numeric not null,
  created_at timestamptz default now()
);

alter table recovery_jobs enable row level security;
alter table recovery_hits enable row level security;

-- intentionally no policies: service_role bypasses RLS; everyone else is denied
