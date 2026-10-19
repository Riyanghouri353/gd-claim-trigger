# G$ Claim Runner — Next.js on Render (free tier)

Runs GoodDollar UBI claims **directly against the `gd-claim` function** for all your
wallets — **fully parallel, no concurrency limit**: every wallet × every chain fires at
once (`Promise.all` all the way down).

## Claim flow per wallet × chain (per the gd-claim API contract)

Two phases per run:

1. **Fee guard** (daily): each wallet's CELO balance is checked via `status`; if below
   `FEE_THRESHOLD_CELO` (default `0.14`), a free top-up is requested from the GoodDollar
   faucet relay (`fundGas`, address-only — no private key sent), then the balance is
   re-checked. Results show on the dashboard per wallet (OK / Topped up / failed).
2. **Claims**: `status` → whitelist/entitlement check → gas short? `fundGas` (CELO faucet),
   wait 30s, re-check → `claim`. Skipped/failed chains are recorded with reasons.

Results are shown live on the dashboard (`/`): per-wallet table with claimed / skipped /
failed pills, amounts, and explorer links.

## Security: encrypted wallet vault

Private keys are **never stored raw** — not in code, not in git, not in env vars, not in
the database:

- Keys live in Supabase table `claim_wallets` as **AES-256-GCM ciphertext**.
- They are decrypted **only in server memory at claim time**, using `PROJECT_KEY`.
- The dashboard shows wallet labels + a 🔒✓/✗ decrypt health check — never keys.
- RLS is enabled with no public policies: only the `service_role` key can read the table.

**Back up your raw private keys AND your `PROJECT_KEY` somewhere safe** (password
manager / offline). Lose `PROJECT_KEY` and the vault cannot be decrypted.

## One-time setup

### 1. Create the vault table
Supabase dashboard → SQL editor → paste `supabase.sql` → Run.

### 2. Generate the project key
On your own machine:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Save the 64-hex output in your password manager. This is `PROJECT_KEY`.

### 3. Encrypt + store your wallets (local machine only)
```bash
PROJECT_KEY=<64-hex from step 2> \
WALLETS_JSON='[{"label":"Wallet 1","privateKey":"0x..."}, …]' \
node scripts/encrypt-wallets.mjs
```
Paste the printed `INSERT` statements into the Supabase SQL editor and run them.
Verify: `select label, chains, created_at from claim_wallets;` — you should see labels
but **never** plaintext keys.

### 4. Render env vars
Dashboard → service → Environment:
- `SUPABASE_URL` = `https://jmayjkfhmjqcxzsjyzyw.supabase.co`
- `SUPABASE_SERVICE_KEY` = service_role key (Supabase → Project Settings → API)
- `PROJECT_KEY` = the 64-hex from step 2
- `CHAINS` = `celo,xdc,fuse`, `GD_CLAIM_URL` = default, ... `CLAIM_TIMES_UTC` = `14:00,18:00,22:00` (3x daily, 4h apart; comma-separated UTC times)

### 5. Add wallets from the dashboard
Open the dashboard → **Add wallet** card: enter a wallet name + private key, pick chains,
and hit **Store encrypted**. The key is AES-256-GCM encrypted server-side before insert —
the dashboard only ever shows wallet names. Remove a wallet with the ✕ button on its row.
(The `scripts/encrypt-wallets.mjs` bulk path still works too.)

### 6. Keep-alive (cron-job.org, free)
Every 10 minutes → `GET https://<your-service>.onrender.com/api/wake`.

### 7. App
Android app → Settings → turn OFF "Automatic Background Claims".

## Deploy

- **Render**: Dashboard → New → Blueprint → connect the repo (uses `render.yaml`).
- **Local dev**: `cp .env.example .env` (fill in) → `npm install` → `npm run dev`.

## Notes
- A Render restart clears in-memory state (last run table) — the next run repopulates it.
- If the faucet rejects a top-up or a chain is out of gas with no faucet (XDC), that
  chain is recorded as failed with the exact reason — other chains/wallets are unaffected.
- The `/api/wake` heartbeat returns immediately; long claim runs execute in the background.

## Riyan Agent (`/agent`)

Personal AI chat agent living on this same service (Render free tier = one
always-on web service). Namespaced under `/agent/*` + `/api/agent/*`; the
claim dashboard and all `/api/*` claim routes are untouched.

- First visit `/agent/setup` to set the login password, then `/agent/login`.
- Settings → add Groq API keys (AES-256-GCM encrypted in Supabase, live-tested
  on save). Requests rotate across healthy keys; 429s cool a key down.
- New tables: run `supabase-agent.sql` in the same Supabase project.
- New env vars: `VAULT_KEY`, `SESSION_SECRET`, `CRON_SECRET`
  (`SUPABASE_URL` / `SUPABASE_SERVICE_KEY` are reused).
- Nightly key-health check: point cron-job.org at
  `/api/agent/cron/key-health` with `Authorization: Bearer $CRON_SECRET`.

Restore point: branch `backup/pre-agent-merge` holds the exact pre-merge
production commit. Roll back with
`git push origin backup/pre-agent-merge:main --force`, or redeploy the
previous deploy in the Render dashboard.
