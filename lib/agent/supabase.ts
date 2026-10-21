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
      lovable_keys: {
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
        Row: { id: string; title: string | null; created_at: string; updated_at: string };
        Insert: { title?: string | null };
        Update: { title?: string | null; updated_at?: string };
        Relationships: [];
      };
      memories: {
        Row: { id: string; content: string; created_at: string };
        Insert: { content: string };
        Update: { content?: string };
        Relationships: [];
      };
      agent_files: {
        Row: { id: string; name: string; mime: string; content: string; size: number; storage_path: string | null; conversation_id: string | null; created_at: string };
        Insert: { id?: string; name: string; mime: string; content: string; size: number; storage_path?: string | null; conversation_id?: string | null };
        Update: { name?: string; mime?: string; content?: string; size?: number; storage_path?: string | null; conversation_id?: string | null };
        Relationships: [];
      };
      sites: {
        Row: { id: string; name: string; slug: string; vercel_project_id: string | null; preview_url: string | null; live_url: string | null; status: string; created_at: string; updated_at: string };
        Insert: { name: string; slug: string; vercel_project_id?: string | null; preview_url?: string | null; live_url?: string | null; status?: string };
        Update: { name?: string; slug?: string; vercel_project_id?: string | null; preview_url?: string | null; live_url?: string | null; status?: string; updated_at?: string };
        Relationships: [];
      };
      site_files: {
        Row: { id: string; site_id: string; path: string; content: string; updated_at: string };
        Insert: { site_id: string; path: string; content: string; updated_at?: string };
        Update: { content?: string; updated_at?: string };
        Relationships: [];
      };
      agent_tasks: {
        Row: { id: string; name: string; instructions: string; schedule_kind: string; time_of_day: string | null; weekday: number | null; interval_minutes: number | null; timezone: string; enabled: boolean; conversation_id: string | null; last_run_at: string | null; next_run_at: string | null; last_status: string | null; created_at: string; updated_at: string };
        Insert: { name: string; instructions: string; schedule_kind?: string; time_of_day?: string | null; weekday?: number | null; interval_minutes?: number | null; timezone?: string; enabled?: boolean; conversation_id?: string | null; last_run_at?: string | null; next_run_at?: string | null; last_status?: string | null };
        Update: { name?: string; instructions?: string; schedule_kind?: string; time_of_day?: string | null; weekday?: number | null; interval_minutes?: number | null; timezone?: string; enabled?: boolean; conversation_id?: string | null; last_run_at?: string | null; next_run_at?: string | null; last_status?: string | null; updated_at?: string };
        Relationships: [];
      };
      agent_task_runs: {
        Row: { id: string; task_id: string; started_at: string; finished_at: string | null; status: string; result_excerpt: string | null; error: string | null };
        Insert: { task_id: string; status?: string; finished_at?: string | null; result_excerpt?: string | null; error?: string | null };
        Update: { status?: string; finished_at?: string | null; result_excerpt?: string | null; error?: string | null };
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
