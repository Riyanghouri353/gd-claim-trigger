// Key/value settings for the collection system (collection_settings table).
// Text values; the pre-existing app_settings table (jsonb, other app's) is untouched.

const SUPA_URL = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = () => process.env.SUPABASE_SERVICE_KEY || '';

async function req(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${SUPA_URL()}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPA_KEY(),
      Authorization: `Bearer ${SUPA_KEY()}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    cache: 'no-store',
  });
  return res;
}

export async function getSetting(key: string, fallback = ''): Promise<string> {
  const res = await req(`collection_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  if (!res.ok) return fallback;
  const rows = (await res.json()) as { value: string }[];
  return rows.length > 0 ? rows[0].value : fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const res = await req(`collection_settings?key=eq.${encodeURIComponent(key)}`, {
    method: 'PATCH',
    body: JSON.stringify({ value, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`setSetting failed: HTTP ${res.status}`);
}

export async function getCollectionSettings(): Promise<{
  enabledChains: string[];
  mainWalletId: string;
  destination: string;
  auto: boolean;
  dustG: string;
  lastRunAt: string;
}> {
  const [enabledChains, mainWalletId, destination, auto, dustG, lastRunAt] = await Promise.all([
    getSetting('collection_enabled_chains', 'celo,xdc'),
    getSetting('collection_main_wallet_id', ''),
    getSetting('collection_destination', ''),
    getSetting('collection_auto', 'false'),
    getSetting('collection_dust_g', '0.01'),
    getSetting('collection_last_run_at', ''),
  ]);
  return {
    enabledChains: enabledChains.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    mainWalletId,
    destination,
    auto: auto === 'true',
    dustG,
    lastRunAt,
  };
}
