import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { GroqKeyRow } from "./keys";

/** Minimal DB typings so insert/upsert/update/select typecheck. */
export type Database = {
  public: {
    Tables: {
      app_settings: {
        Row: { key: string; value: string };
        Insert: { key: string; value: string };
        Update: { key?: string; value?: string };
        Relationships: [];
      };
      groq_keys: {
        Row: GroqKeyRow;
        Insert: {
          label: string;
          enc_key: string;
          iv: string;
          tag: string;
          disabled?: boolean;
          cooldown_until?: string | null;
          last_used_at?: string | null;
        };
        Update: {
          label?: string;
          enc_key?: string;
          iv?: string;
          tag?: string;
          disabled?: boolean;
          cooldown_until?: string | null;
          last_used_at?: string | null;
        };
        Relationships: [];
      };
      gemini_keys: {
        Row: GroqKeyRow;
        Insert: {
          label: string;
          enc_key: string;
          iv: string;
          tag: string;
          disabled?: boolean;
          cooldown_until?: string | null;
          last_used_at?: string | null;
        };
        Update: {
          label?: string;
          enc_key?: string;
          iv?: string;
          tag?: string;
          disabled?: boolean;
          cooldown_until?: string | null;
          last_used_at?: string | null;
        };
        Relationships: [];
      };
      connectors: {
        Row: {
          id: string;
          name: string;
          enc_config: string;
          iv: string;
          tag: string;
          enabled: boolean;
          created_at: string;
        };
        Insert: {
          name: string;
          enc_config: string;
          iv: string;
          tag: string;
          enabled?: boolean;
        };
        Update: { name?: string; enc_config?: string; iv?: string; tag?: string; enabled?: boolean };
        Relationships: [];
      };
      conversations: {
        Row: { id: string; title: string | null; created_at: string };
        Insert: { title?: string | null };
        Update: { title?: string | null };
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          conversation_id: string;
          role: string;
          content: string;
          created_at: string;
        };
        Insert: { conversation_id: string; role: string; content: string };
        Update: { content?: string };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
  };
}

let client: SupabaseClient<Database> | null = null;

/**
 * Next.js caches fetch() in Server Components by default — and the Supabase
 * client uses fetch internally. Without this, the first "not set up yet"
 * answer gets cached and the login/setup pages loop forever.
 */
function noStoreFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, cache: "no-store" });
}

/**
 * Service-role client. Bypasses RLS — server-side only, never import into
 * client components. All tables have RLS enabled with no public policies,
 * so this is the only path that can read/write.
 */
export function getServiceClient() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    // Agent reads the same Supabase project as the claim runner.
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY env vars");
    }
    client = createClient<Database>(url, key, {
      auth: { persistSession: false },
      global: { fetch: noStoreFetch },
    });
  }
  return client;
}
