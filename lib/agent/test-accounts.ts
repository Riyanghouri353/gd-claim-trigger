import { randomBytes } from "node:crypto";
import { getServiceClient } from "./supabase";
import { encryptSecret, decryptSecret } from "./crypto";
import { getSetting, setSetting } from "./keys";

/**
 * Test accounts vault: credentials the agent may use to sign up / log in
 * during testing and web tasks. Passwords are AES-256-GCM encrypted at
 * rest and are NEVER returned to the model or the chat — the browser
 * layer substitutes {{account:...}} tokens server-side at fill time.
 */

export interface TestAccountSafe {
  id: string;
  site: string;
  label: string;
  email: string;
  username: string;
  generated: boolean;
  created_at: string;
}

interface AccountRow extends TestAccountSafe {
  secret_enc: string;
}

function toSafe(r: AccountRow): TestAccountSafe {
  const { secret_enc: _drop, ...safe } = r;
  return safe;
}

export async function listTestAccounts(): Promise<TestAccountSafe[]> {
  const sb = getServiceClient();
  const { data, error } = await sb
    .from("test_accounts")
    .select("id, site, label, email, username, secret_enc, generated, created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as unknown as AccountRow[]).map(toSafe);
}

export async function createTestAccount(input: {
  site: string;
  label?: string;
  email?: string;
  username?: string;
  password: string;
  generated?: boolean;
}): Promise<TestAccountSafe> {
  const sb = getServiceClient();
  const bundle = encryptSecret(input.password);
  const { data, error } = await sb
    .from("test_accounts")
    .insert({
      site: input.site.trim(),
      label: (input.label || "").trim(),
      email: (input.email || "").trim(),
      username: (input.username || "").trim(),
      secret_enc: JSON.stringify(bundle),
      generated: !!input.generated,
    })
    .select("id, site, label, email, username, secret_enc, generated, created_at")
    .single();
  if (error) throw new Error(error.message);
  return toSafe(data as unknown as AccountRow);
}

export async function deleteTestAccount(id: string): Promise<void> {
  const sb = getServiceClient();
  const { error } = await sb.from("test_accounts").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Find one account by id (uuid) or by site substring (case-insensitive). */
export async function findTestAccount(idOrSite: string): Promise<AccountRow | null> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("test_accounts")
    .select("id, site, label, email, username, secret_enc, generated, created_at")
    .order("created_at", { ascending: false });
  const rows = (data as unknown as AccountRow[]) || [];
  const byId = rows.find((r) => r.id === idOrSite);
  if (byId) return byId;
  const needle = idOrSite.toLowerCase();
  return rows.find((r) => r.site.toLowerCase().includes(needle)) || null;
}

/** Decrypt one field of an account. Server-side only — never expose via tools. */
export async function resolveAccountField(
  idOrSite: string,
  field: "email" | "username" | "password"
): Promise<string | null> {
  const row = await findTestAccount(idOrSite);
  if (!row) return null;
  if (field === "email") return row.email || null;
  if (field === "username") return row.username || null;
  try {
    return decryptSecret(JSON.parse(row.secret_enc));
  } catch {
    return null;
  }
}

// --- Generated identities -----------------------------------------------------

const FIRST = ["Test", "Demo", "Qa", "Sample", "Trial", "Alpha", "Beta", "Pilot"];
const SECOND = ["User", "Account", "Person", "Tester", "Member", "Guest"];

function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%";
  const bytes = randomBytes(18);
  let out = "";
  for (let i = 0; i < 18; i++) out += chars[bytes[i] % chars.length];
  return out + "9a!";
}

export async function getTestEmailDomain(): Promise<string> {
  return (await getSetting("test_email_domain").catch(() => null)) || "example.com";
}

export async function setTestEmailDomain(domain: string): Promise<void> {
  await setSetting("test_email_domain", domain.trim().replace(/^@/, ""));
}

/**
 * Create and store a fresh test identity for a site (for sign-up flows).
 * Returns the safe record; the password stays in the vault and is used
 * via {{account:...}} tokens, so the agent can log in again later.
 */
export async function generateTestIdentity(site: string, label?: string): Promise<TestAccountSafe> {
  const domain = await getTestEmailDomain();
  const rand = randomBytes(3).toString("hex");
  const first = FIRST[randomBytes(1)[0] % FIRST.length];
  const second = SECOND[randomBytes(1)[0] % SECOND.length];
  const slug =
    site
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 14) || "site";
  const username = `${first.toLowerCase()}${second.toLowerCase()}_${rand}`;
  const email = `test+${slug}${rand}@${domain}`;
  return createTestAccount({
    site: site.trim(),
    label: label || `${first} ${second} (generated)`,
    email,
    username,
    password: randomPassword(),
    generated: true,
  });
}
