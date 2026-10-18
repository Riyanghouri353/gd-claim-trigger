-- Encrypted wallet vault for the G$ claim runner.
-- Run this once in the Supabase dashboard → SQL editor.
--
-- SECURITY: RLS is enabled with NO public policies, so only the service_role
-- key (used server-side by the app) can read. The anon key sees nothing.
-- The encrypted_key column holds AES-256-GCM ciphertext; decryption needs the
-- PROJECT_KEY env var, which lives only on the Render service.

create table if not exists claim_wallets (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  encrypted_key text not null,
  chains text not null default 'celo,xdc,fuse',
  address text, -- derived from the private key once at insert; used for balance lookups (no key needed)
  created_at timestamptz default now()
);

alter table claim_wallets enable row level security;

-- intentionally no policies: service_role bypasses RLS; everyone else is denied
