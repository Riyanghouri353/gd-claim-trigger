import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getServiceClient } from "./supabase";
import { encryptSecret, decryptSecret } from "./crypto";

export type AuthType = "bearer" | "header" | "query" | "basic" | "none";

export interface ConnectorConfig {
  baseUrl: string;
  authType: AuthType;
  /** header name (authType=header), query param (authType=query), username (authType=basic) */
  authField?: string;
  /** the secret API key / token / password — never leaves the server */
  key: string;
  /** optional path tested on save, e.g. "/v1/models" */
  testPath?: string;
}

export interface ConnectorRow {
  id: string;
  name: string;
  baseUrl: string;
  authType: AuthType;
  enabled: boolean;
  created_at: string;
}

function rowOf(r: any): ConnectorRow {
  const cfg = JSON.parse(
    decryptSecret({ enc: r.enc_config, iv: r.iv, tag: r.tag })
  ) as ConnectorConfig;
  return {
    id: r.id,
    name: r.name,
    baseUrl: cfg.baseUrl,
    authType: cfg.authType,
    enabled: r.enabled,
    created_at: r.created_at,
  };
}

/** List connectors — metadata only, secrets never leave the vault. */
export async function listConnectors(): Promise<ConnectorRow[]> {
  const { data, error } = await getServiceClient()
    .from("connectors")
    .select("id,name,enc_config,iv,tag,enabled,created_at")
    .order("created_at");
  if (error) throw error;
  return (data ?? []).map(rowOf);
}

async function getConfigByName(name: string): Promise<ConnectorConfig> {
  const { data, error } = await getServiceClient()
    .from("connectors")
    .select("enc_config,iv,tag,enabled")
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Connector "${name}" not found`);
  if (!data.enabled) throw new Error(`Connector "${name}" is disabled`);
  return JSON.parse(
    decryptSecret({ enc: data.enc_config, iv: data.iv, tag: data.tag })
  ) as ConnectorConfig;
}

export async function saveConnector(name: string, cfg: ConnectorConfig) {
  const { enc, iv, tag } = encryptSecret(JSON.stringify(cfg));
  const { error } = await getServiceClient()
    .from("connectors")
    .upsert({ name, enc_config: enc, iv, tag }, { onConflict: "name" });
  if (error) throw error;
}

export async function deleteConnector(id: string) {
  const { error } = await getServiceClient().from("connectors").delete().eq("id", id);
  if (error) throw error;
}

export async function setConnectorEnabled(id: string, enabled: boolean) {
  const { error } = await getServiceClient()
    .from("connectors")
    .update({ enabled })
    .eq("id", id);
  if (error) throw error;
}

/** Build the final URL + headers for a connector call. */
function buildRequest(cfg: ConnectorConfig, path: string, query?: Record<string, string>) {
  const cleanPath = (path || "/").replace(/^\/+/, "");
  const url = new URL(cfg.baseUrl.replace(/\/+$/, "") + "/" + cleanPath);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (cfg.authType === "bearer") headers["Authorization"] = `Bearer ${cfg.key}`;
  else if (cfg.authType === "header" && cfg.authField) headers[cfg.authField] = cfg.key;
  else if (cfg.authType === "query" && cfg.authField) url.searchParams.set(cfg.authField, cfg.key);
  else if (cfg.authType === "basic")
    headers["Authorization"] =
      "Basic " + Buffer.from(`${cfg.authField || ""}:${cfg.key}`).toString("base64");
  return { url, headers };
}

function isBlockedIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ip.split(".").map(Number);
    if (n[0] === 10) return true;
    if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true;
    if (n[0] === 192 && n[1] === 168) return true;
    if (n[0] === 127 || n[0] === 0 || n[0] >= 224) return true;
    if (n[0] === 169 && n[1] === 254) return true;
    return false;
  }
  const l = ip.toLowerCase();
  return (
    l === "::1" || l === "::" || l.startsWith("fe80") || l.startsWith("fc") ||
    l.startsWith("fd") || l.startsWith("ff")
  );
}

/** SSRF guard: only public http(s) hosts, no private/loopback/link-local IPs. */
export async function assertPublicUrl(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only http/https URLs are allowed");
  if (url.username || url.password) throw new Error("Credentials in URL are not allowed");
  let addrs: { address: string }[];
  try {
    addrs = await lookup(url.hostname, { all: true });
  } catch {
    throw new Error(`DNS resolution failed for ${url.hostname}`);
  }
  if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address)))
    throw new Error("Private/internal hosts are blocked");
}

export async function fetchWithTimeout(url: URL, init: RequestInit, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(t);
  }
}

/** Live-test a connector config before saving. */
export async function testConnector(cfg: ConnectorConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const { url, headers } = buildRequest(cfg, cfg.testPath || "/");
    await assertPublicUrl(url);
    const res = await fetchWithTimeout(url, { headers }, 20000);
    if (res.status === 401 || res.status === 403)
      return { ok: false, detail: `Auth rejected (HTTP ${res.status}) — check the key` };
    if (res.status >= 500) return { ok: false, detail: `Server error (HTTP ${res.status})` };
    return { ok: true, detail: `Reachable (HTTP ${res.status})` };
  } catch (e: any) {
    return { ok: false, detail: e?.message || "Connection failed" };
  }
}

export interface ConnectorCallResult {
  ok: boolean;
  status: number;
  body: string;
  truncated: boolean;
}

/** Recursively shrink a JSON value: trim long strings, cap nesting depth. */
function compactValue(v: any, depth: number): any {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) {
    if (depth > 3) return `[${v.length} items]`;
    return v.slice(0, 50).map((i) => compactValue(i, depth + 1));
  }
  if (typeof v === "object") {
    if (depth > 3) return "{…}";
    const o: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      o[k] = typeof val === "string" && val.length > 250 ? val.slice(0, 250) + "…" : compactValue(val, depth + 1);
    }
    return o;
  }
  if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + "…";
  return v;
}

/**
 * Make a tool response model-friendly: always valid JSON made of COMPLETE
 * items (never chopped mid-object), capped in size, with a _meta note when
 * items were dropped. Falls back to plain truncation for non-JSON bodies.
 */
function compactBody(text: string, maxChars = 5000): { body: string; truncated: boolean } {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    return { body: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  if (Array.isArray(v)) {
    let items = v.map((i) => compactValue(i, 0));
    while (items.length > 1 && JSON.stringify(items).length > maxChars) items.pop();
    const body =
      items.length < v.length
        ? JSON.stringify({ data: items, _meta: { showing: items.length, total: v.length } })
        : JSON.stringify(items);
    return { body, truncated: items.length < v.length };
  }
  const compacted = JSON.stringify(compactValue(v, 0));
  if (compacted.length <= maxChars) return { body: compacted, truncated: false };
  return { body: compacted.slice(0, maxChars), truncated: true };
}

/** Execute an HTTP call through a saved connector (server-side, key injected). */
export async function callConnector(
  name: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  query?: Record<string, string>,
  body?: unknown
): Promise<ConnectorCallResult> {
  const cfg = await getConfigByName(name);
  const { url, headers } = buildRequest(cfg, path, query);
  await assertPublicUrl(url);
  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== "GET" && method !== "DELETE") {
    headers["Content-Type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetchWithTimeout(url, init);
  const text = await res.text();
  // Compact the payload so the model always gets complete, valid JSON
  // (never chopped mid-object) — broken JSON makes it re-call the tool.
  const { body: compacted, truncated } = compactBody(text);
  return { ok: res.ok, status: res.status, body: compacted, truncated };
}
