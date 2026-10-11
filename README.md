# G$ Claim Runner — Next.js on Render (free tier)

Runs GoodDollar UBI claims **directly against the `gd-claim` function** for all your
wallets — **fully parallel, no concurrency limit**: every wallet × every chain fires at
once (`Promise.all` all the way down).

## Claim flow per wallet × chain (per the gd-claim API contract)

1. `status` with the private key → whitelist, entitlement, gas balance, fee estimate
2. Not whitelisted / no entitlement → recorded as **skipped**, no transaction attempted
3. Gas short? → `fundGas` with the address only (CELO faucet), wait 30s, re-check `status`
4. `claim` with the private key → tx hash + explorer link, or a human-readable error

Results are shown live on the dashboard (`/`): per-wallet table with claimed / skipped /
failed pills, amounts, and explorer links.

## Security

- Private keys live **only** in the `WALLETS_JSON` environment variable (Render encrypts
  env vars at rest). They are **never** in code, never in git, never rendered in the UI.
- Keys are sent to the `gd-claim` function per its documented security model (held in
  server memory for one request, zeroed afterwards, never logged/stored).
- The dashboard shows wallet **labels only** — no keys, no addresses.

## Deploy

### 1. Push to GitHub
Push this folder as a repo (public or private — no secrets in the code).

### 2. Render
- Dashboard → **New → Blueprint** → connect the repo (uses `render.yaml`), or
  **New → Web Service** manually: build `npm install && npm run build`, start `npm start`, plan **Free**.
- Environment variables:
  - `WALLETS_JSON` = `[{"label":"Wallet 1","privateKey":"0x..."}, …]` (all 10 wallets)
  - `CHAINS` = `celo,xdc,fuse`
  - `GD_CLAIM_URL` = `https://uiwsjxfcdruvqnbgdwdd.supabase.co/functions/v1/gd-claim`
  - `CLAIM_TIME_UTC` = `18:00` (daily time, HH:MM UTC)

### 3. Keep-alive (cron-job.org, free)
Create a job: every 10 minutes → `GET https://<your-service>.onrender.com/api/wake`.
This keeps Render's free tier awake (sleeps after 15 idle minutes) and each hit is the
clock tick — when the claim time is due, the full parallel run starts in the background
(the heartbeat returns immediately, so no timeout can cut the run off).

### 4. App
Android app → Settings → turn OFF "Automatic Background Claims" (the server owns it now).

## Local dev
```bash
cp .env.example .env   # fill in real values — never commit this file
npm install
npm run dev
```

## Notes
- A Render restart clears in-memory state (last run table) — the next run repopulates it.
- If the faucet rejects a top-up or a chain is out of gas with no faucet (XDC), that
  chain is recorded as failed with the exact reason — other chains/wallets are unaffected.
