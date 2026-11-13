// Shared client for the external gd-claim endpoint (third-party Supabase
// Edge Function). Single place for timeout, retry, jitter and the circuit
// breaker — previously runner.ts and fees.ts each had their own copy, and
// the runner's had NO timeout, so one hung call could stall a whole run.
//
// Retry policy (from the Nov 2026 failure analysis):
// - HTTP 5xx (incl. Supabase 546 function errors) — endpoint-side, transient.
// - "gas fee cap is below the minimum base fee" — Celo base-fee spike at
//   broadcast time; the tx was never mined, entitlement untouched.
// - Network errors / timeouts.
// Retries: 2, at 15s and 45s (+/-20% jitter). Status is read-only; claim
// re-checks entitlement server-side, so a retry can never double-claim.
//
// Circuit breaker: after 5 consecutive endpoint-side failures the client
// fails fast for 60s instead of hammering a dying endpoint with 33
// parallel retries. Callers see HTTP 503 + a "circuit open" message and
// treat it as a normal retryable failure (next slot / next retry window).

import { getGdClaimUrl } from './wallets';
import { jittered, sleep } from './limits';

export interface GdResponse {
  httpStatus: number;
  [key: string]: unknown;
}

export const GD_TIMEOUT_MS = 90_000;
const RETRY_DELAYS_MS = [15_000, 45_000];
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

let consecutiveEndpointFailures = 0;
let breakerOpenUntil = 0;

export function gdCircuitState(): { open: boolean; failures: number; openUntil: number } {
  return {
    open: Date.now() < breakerOpenUntil,
    failures: consecutiveEndpointFailures,
    openUntil: breakerOpenUntil,
  };
}

function recordEndpointFailure(): void {
  consecutiveEndpointFailures += 1;
  if (consecutiveEndpointFailures >= BREAKER_THRESHOLD && Date.now() >= breakerOpenUntil) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.error(
      `gd-claim circuit breaker OPEN for ${BREAKER_COOLDOWN_MS / 1000}s after ${consecutiveEndpointFailures} consecutive endpoint failures`,
    );
  }
}

function recordEndpointSuccess(): void {
  consecutiveEndpointFailures = 0;
  breakerOpenUntil = 0;
}

export function isRetryableGd(httpStatus: number, errorText: string): boolean {
  if (httpStatus >= 500) return true;
  if (/gas fee cap is below the minimum base fee/i.test(errorText)) return true;
  return false;
}

export async function gdCall(
  action: 'status' | 'claim' | 'fundGas',
  chain: string,
  extra: Record<string, string>,
): Promise<GdResponse> {
  if (Date.now() < breakerOpenUntil) {
    return {
      httpStatus: 503,
      error: 'gd-claim circuit open (endpoint failing repeatedly — backing off, retry next window)',
      circuitOpen: true,
    };
  }
  let last: GdResponse | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(getGdClaimUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, chain, ...extra }),
        cache: 'no-store',
        signal: AbortSignal.timeout(GD_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const out: GdResponse = { httpStatus: res.status, ...data };
      const retryable = isRetryableGd(res.status, String(data.error ?? ''));
      if (retryable) recordEndpointFailure();
      else recordEndpointSuccess();
      if (!retryable || attempt === RETRY_DELAYS_MS.length) return out;
      last = out;
    } catch (e) {
      lastErr = e;
      recordEndpointFailure();
      if (attempt === RETRY_DELAYS_MS.length) throw e;
    }
    await sleep(jittered(RETRY_DELAYS_MS[attempt]));
  }
  if (last) return last;
  throw lastErr ?? new Error('gd-claim request failed');
}
