// Shared concurrency + timing helpers for the claim runner.
//
// The runner used to fire every wallet x chain call at once (Promise.all,
// no limit). Live evidence (Nov 2026) showed the burst tripping public RPC
// rate limits (XDC balance reads failing with HTTP 502 under load), so all
// fan-out now goes through pMap with a bounded pool.

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Delay with +/-20% jitter so parallel retries don't re-hit the endpoint in lockstep. */
export function jittered(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/**
 * Map over items with at most `concurrency` promises in flight.
 * Results keep input order. A rejected worker rejects the whole map —
 * callers that must isolate failures should catch inside `fn`.
 */
export async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const cap = Math.max(1, Math.floor(concurrency) || 1);
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(cap, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
