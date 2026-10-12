# G$ Claim Runner — system design

Autonomous daily GoodDollar UBI claims for N wallets × (Celo, XDC, Fuse),
running fully parallel with no concurrency limit.

## Components

| Piece | Where | What it does |
|---|---|---|
| Trigger | cron-job.org → `GET /api/wake` every 10 min | Keep-alive + clock tick |
| Scheduler | `lib/claim.ts` (`isDue`) | One run per day at/after `CLAIM_TIME_UTC` |
| Fee guard | `lib/fees.ts` (`checkFees`) | Daily CELO top-up below `FEE_THRESHOLD_CELO` |
| Claim engine | `lib/runner.ts` (`runAllWallets`) | Parallel wallet×chain claims |
| Vault | Supabase `claim_wallets` | AES-256-GCM encrypted keys (`lib/crypto.ts`) |
| Dashboard | `/` (`components/Dashboard.tsx`) | Live status, vault manager, fee guard, results |

## Daily flow

1. cron-job.org hits `/api/wake` every 10 min.
2. First tick at/after `CLAIM_TIME_UTC` (UTC) with no completed run today → `runAllWallets()` starts **in the background**; the tick responds immediately.
3. **Phase 1 — fee guard:** each wallet's CELO balance is checked; below `0.13` CELO → `fundGas` via the GoodDollar faucet (address-only), wait 30s, re-check. Never fatal to claims.
4. **Phase 2 — claims:** per wallet × chain: `status` → skip if not whitelisted / no entitlement → fund gas if short (CELO faucet) → `claim`. All concurrent.
5. On success the calendar day is marked complete. Results + fee check persist in memory for the dashboard.

## Guarantees (failure modes)

- **Late/cold tick never skips a day:** any tick at/after claim time runs once; there is no narrow trigger window.
- **Failed runs retry:** the day is marked complete only on success — a crash leaves the next tick eligible.
- **One bad wallet can't kill the run:** a row that fails to decrypt is reported per-wallet; the rest proceed.
- **No doomed claims:** after a faucet top-up, gas is re-checked before attempting `claim`.
- **Concurrent triggers are safe:** `isRunning()` guards wake/trigger/fee endpoints (409 on manual double-trigger).
- **Garbage `CLAIM_TIME_UTC` can't crash the app:** invalid values fall back to `18:00`.
- **Fresh reads:** all Supabase fetches use `cache: 'no-store'` (a stale-cache bug was found and fixed in testing).
- **Restart-safe:** in-memory state (last run, dedup date) resets on restart; the next tick simply runs if due. Claims are idempotent — already-claimed wallets report "no entitlement" and skip.

## Security model

- Keys are AES-256-GCM ciphertext in Supabase; decryption needs `PROJECT_KEY` (Render env only) and happens in server memory at run time.
- RLS enabled with no public policies — only `service_role` reads the table.
- The `gd-claim` API needs the private key per request (its documented trust model: memory-only, redacted, zeroed).
- Dashboard and all APIs expose wallet **names only** — never keys.
- No secrets in git (verified by scan). Back up `PROJECT_KEY` + raw keys offline: losing `PROJECT_KEY` = losing the vault.

## Environment

| Var | Secret | Purpose |
|---|---|---|
| `SUPABASE_URL` | no | Vault database |
| `SUPABASE_SERVICE_KEY` | yes | service_role for vault reads/writes |
| `PROJECT_KEY` | yes | 64-hex AES-256-GCM key |
| `CHAINS` | no | Default chains (`celo,xdc,fuse`) |
| `GD_CLAIM_URL` | no | gd-claim function endpoint |
| `CLAIM_TIME_UTC` | no | Daily run time (`18:00`) |
| `FEE_THRESHOLD_CELO` | no | Faucet top-up threshold (`0.13`) |
