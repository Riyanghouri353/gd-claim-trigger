# G$ Claim Runner — system design

Autonomous daily GoodDollar UBI claims for N wallets × (Celo, XDC, Fuse),
running in a bounded-parallel pool (6 in flight) with retries, persistent
slot state, and run history. (The `/agent` app shares this repo + Render
service but is a separate system — see its own docs; claim code never
touches `app/agent/`, `app/api/agent/`, `lib/agent/`.)

## Components

| Piece | Where | What it does |
|---|---|---|
| Trigger | cron-job.org → `GET /api/wake` every 10 min | Keep-alive + clock tick |
| Scheduler | `lib/claim.ts` (`dueSlots`) | Slots due at/after `CLAIM_TIMES_UTC`; persisted in Supabase `claim_slots` |
| Fee guard | `lib/fees.ts` (`checkFees`) | CELO top-up below `FEE_THRESHOLD_CELO` via faucet; verified, single-flight |
| Gas monitor | `lib/gas.ts` (`checkGasLevels`) | RPC-only native balances for ALL chains; flags FUSE/XDC shortages |
| Claim engine | `lib/runner.ts` (`runAllWallets`) | Bounded-parallel wallet×chain claims |
| gd-claim client | `lib/gd.ts` (`gdCall`) | Timeout + jittered retries + circuit breaker for the endpoint |
| Vault | Supabase `claim_wallets` | AES-256-GCM encrypted keys (`lib/crypto.ts`); soft-delete + audit |
| History | Supabase `claim_runs` + `claim_run_results` | Every run recorded (`lib/history.ts`) |
| Alerts | `lib/alerts.ts` (Resend) | Crash / failure / escalation / digest emails; state in `alert_state` |
| Admin auth | `lib/adminAuth.ts` | Session password for destructive endpoints only |
| Dashboard | `/` (`components/AppShell.tsx` + `sections/*`) | Live status, vault manager, fee guard, logs + history |

## Daily flow

1. cron-job.org hits `/api/wake` every 10 min.
2. The first tick at/after each time in `CLAIM_TIMES_UTC` (e.g. `14:00,18:00,22:00`) with that
   slot due starts `runAllWallets()` **in the background**; the tick responds immediately.
3. **Phase 1 — fee guard + gas monitor (concurrent, neither fatal):** each wallet's CELO
   balance is checked; below `0.25` CELO → `fundGas` via the GoodDollar faucet (address-only),
   wait 30s, re-check (twice) — a top-up only counts when the balance actually rises. The gas
   monitor reads all-chain native balances via RPC and flags shortages.
4. **Phase 2 — claims:** per wallet × chain: `status` → `blocked` if not whitelisted
   (verification lost — needs GoodID re-verification, never a silent skip) → skip if no
   entitlement → fund gas if short (CELO faucet, re-check twice) → `claim`. Bounded pool of 6.
5. Slot outcome is recorded: a slot completes only on a zero-failure run, or after 3 attempts
   (exhausted). Failed slots stay due with a 30-minute retry gap. The run is recorded to
   history and failure/blocked alerts are evaluated.

## Guarantees (failure modes)

- **Late/cold tick never skips a slot:** any tick at/after a scheduled time runs it once; there is no narrow trigger window.
- **Failed runs retry:** slots complete only on zero-failure runs or after 3 attempts — a crash or a failed run leaves the slot retryable (30-min gap between attempts).
- **One bad wallet can't kill the run:** a row that fails to decrypt is reported per-wallet; the rest proceed.
- **No doomed claims:** after a faucet top-up, gas is re-checked (twice) before attempting `claim`.
- **Concurrent triggers are safe:** `isRunning()` guards wake/trigger (409 on manual double-trigger); a run older than 20 min is treated as stale/dead so a hung call can't block the schedule forever.
- **Endpoint outages back off:** the gd-claim client retries 5xx/gas-fee-cap errors twice (15s/45s + jitter) and opens a circuit breaker after 5 consecutive endpoint failures (60s fail-fast).
- **Garbage `CLAIM_TIMES_UTC` can't crash the app:** invalid values fall back to `18:00`.
- **Fresh reads:** all Supabase fetches use `cache: 'no-store'` (a stale-cache bug was found and fixed in testing).
- **Restart-safe:** slot state, run history, and alert state persist in Supabase; in-memory caches are mirrors with the same rules. Claims are idempotent — already-claimed wallets report "no entitlement" and skip.

## Alerts

Email alerts via Resend, from `riyan@ghouri.site` to `riyanghouri7@gmail.com`
(overridable via `ALERT_FROM` / `ALERT_EMAIL`):
- **Run crash** (Supabase down, decrypt blowup, unexpected error): alerts immediately,
  every time. The slot is not marked complete, so a later tick retries.
- **Run completed with claim failures / blocked chains**: alerts with per-wallet/per-chain
  details, fee-guard + gas-monitor status, and a dashboard link. Throttling: identical
  failure sets re-alert at most every 12h; every 3rd consecutive failing run escalates
  immediately; a daily digest fires while failures persist; a NEW whitelist loss always
  alerts at once. The failure signature includes the error class, so a changed failure
  reason re-alerts even for the same wallets/chains.
- Skipped claims (no entitlement) never alert — that's normal.
- Alert sending never breaks a run: every send is wrapped in try/catch.
- Requires `RESEND_API_KEY` in env (sending-only key); without it, alerts are
  skipped with a console warning.

## Vault balances

The Vault screen shows each wallet's address (derived from its key once at
insert, stored in the `address` column — backfilled automatically for older
rows) and live native + G$ balances per chain via `GET /api/balances`.
Balance lookups need no private keys: `lib/balances.ts` calls `eth_getBalance`
and `eth_call(balanceOf)` against public RPCs with per-chain fallbacks
(Celo: forno → ankr; Fuse: rpc.fuse.io → drpc; XDC: ankr → erpc).
Lookups run in a bounded pool (8); one slow RPC can't block the rest, and a
rate-limit failure gets one delayed retry of the primary RPC.
A "Refresh balances" button re-fetches on demand.

## Security model

- Keys are AES-256-GCM ciphertext in Supabase; decryption needs `PROJECT_KEY` (Render env only) and happens in server memory at run time.
- RLS enabled with no public policies — only `service_role` reads the tables.
- The `gd-claim` API needs the private key per request (its documented trust model: memory-only, redacted, zeroed).
- Dashboard reads (`/api/status`, `/api/balances`, `/api/history`, `/api/health`, `/api/wake`) are open and expose wallet **names only** — never keys.
- Destructive endpoints (`/api/wallets` add/remove/restore/backup, `/api/trigger`, `/api/fees`) require the admin session (iron-session cookie, 7 days) or a Bearer token, gated by `ADMIN_PASSWORD` (32+ chars, Render env). When unset, they fail closed. Login attempts are rate-limited (5 per 5 min per IP).
- Removal is soft-delete (`deleted_at`): removed wallets stay recoverable via Restore, and every vault change is written to `wallet_audit`. An encrypted vault backup (ciphertext only) can be downloaded from the Vault tab.
- No secrets in git (verified by scan). Back up `PROJECT_KEY` + raw keys offline: losing `PROJECT_KEY` = losing the vault.

## Environment

| Var | Secret | Purpose |
|---|---|---|
| `SUPABASE_URL` | no | Vault database |
| `SUPABASE_SERVICE_KEY` | yes | service_role for vault reads/writes |
| `PROJECT_KEY` | yes | 64-hex AES-256-GCM key |
| `CHAINS` | no | Default chains (`celo,xdc,fuse`) |
| `GD_CLAIM_URL` | no | gd-claim function endpoint |
| `CLAIM_TIME_UTC` | no | Legacy single run time (`18:00`) — used only if `CLAIM_TIMES_UTC` is unset |
| `CLAIM_TIMES_UTC` | no | Comma-separated daily run times, UTC (`14:00,18:00,22:00` = 3x a day, 4h apart) |
| `FEE_THRESHOLD_CELO` | no | Faucet top-up threshold (`0.25`; live claim cost ~0.194 CELO) |
| `FEE_THRESHOLD_FUSE` | no | Gas-monitor low threshold (`0.01`; observed claim needs 0.0047–0.0087 FUSE) |
| `FEE_THRESHOLD_XDC` | no | Gas-monitor low threshold (`0.01`; endpoint fee data ~0.0057 XDC) |
| `ADMIN_PASSWORD` | yes | 32+ chars; gates destructive dashboard endpoints (Render env only, not in render.yaml) |
| `RESEND_API_KEY` | yes | Sending-only Resend key for email alerts |

## Database tables (Supabase, `supabase.sql` + `supabase-migration-p0p1.sql`)

| Table | Purpose |
|---|---|
| `claim_wallets` | Encrypted vault (+ `address`, `deleted_at` soft-delete) |
| `claim_runs` | One row per run (summary + slot label + fee summary) |
| `claim_run_results` | One row per wallet × chain result |
| `claim_slots` | Persistent slot attempts/completion |
| `wallet_audit` | Vault add/remove/restore/backup audit trail |
| `alert_state` | Alert cooldown + consecutive-failure state (single row `failures`) |
