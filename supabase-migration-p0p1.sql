-- P0+P1 migration for the G$ Claim Runner (2026-11-13).
-- Additive only: no existing table or column is dropped or altered in a
-- destructive way. claim_wallets gains ONE nullable column (deleted_at) for
-- soft-delete; existing rows are untouched (deleted_at stays NULL = active).
--
-- Applied via the Supabase Management API. Safe to re-run (IF NOT EXISTS /
-- ON CONFLICT guards throughout).
--
-- SECURITY: same pattern as supabase.sql — RLS enabled, NO public policies,
-- so only the service_role key (server-side) can read/write these tables.

-- 1. Soft-delete column on the vault (additive; existing keys untouched).
alter table if exists claim_wallets
  add column if not exists deleted_at timestamptz;

-- 2. Run history: one row per run (summary) ...
create table if not exists claim_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  slot_label text not null default 'manual run',
  claimed int not null default 0,
  skipped int not null default 0,
  failed int not null default 0,
  blocked int not null default 0,
  fee_summary jsonb,
  created_at timestamptz default now()
);
create index if not exists claim_runs_started_idx on claim_runs (started_at desc);

-- ... plus one row per wallet x chain result.
create table if not exists claim_run_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references claim_runs(id) on delete cascade,
  wallet_label text not null,
  chain text not null,
  status text not null,
  amount text,
  tx_hash text,
  message text,
  funded_gas boolean not null default false,
  created_at timestamptz default now()
);
create index if not exists claim_run_results_run_idx on claim_run_results (run_id);

-- 3. Persistent schedule slots: attempts + completion survive restarts.
-- A slot is only "complete" when a run finishes it with zero failures, or
-- after MAX_ATTEMPTS attempts (exhausted). Failed slots stay retryable.
create table if not exists claim_slots (
  slot_key text primary key,
  attempts int not null default 0,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  last_claimed int not null default 0,
  last_skipped int not null default 0,
  last_failed int not null default 0,
  last_blocked int not null default 0,
  updated_at timestamptz default now()
);

-- 4. Audit trail for vault changes (add / remove / restore). Never stores keys.
create table if not exists wallet_audit (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  action text not null,
  wallet_id text,
  wallet_label text,
  detail text
);
create index if not exists wallet_audit_created_idx on wallet_audit (created_at desc);

-- 5. Alert state: cooldown signature + consecutive-failure counter survive
-- restarts, so alert suppression and escalation stay correct across deploys.
create table if not exists alert_state (
  id text primary key,
  sig text not null default '',
  alerted_at timestamptz,
  consecutive_failed_runs int not null default 0,
  last_digest_at timestamptz,
  blocked_sig text not null default '',
  updated_at timestamptz default now()
);
insert into alert_state (id) values ('failures') on conflict (id) do nothing;

-- RLS on every new table, intentionally no policies (service_role only).
alter table claim_runs enable row level security;
alter table claim_run_results enable row level security;
alter table claim_slots enable row level security;
alter table wallet_audit enable row level security;
alter table alert_state enable row level security;
