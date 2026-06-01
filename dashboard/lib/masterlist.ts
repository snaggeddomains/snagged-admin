// Service-role client for the SEPARATE Supabase project that hosts the curated
// "Master Domain List". Backend-only. Used by the Admin Imports tool.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

function key(): string | undefined {
  return (
    process.env.MASTERLIST_SUPABASE_SECRET_KEY ||
    process.env.MASTERLIST_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.MASTERLIST_SUPABASE_KEY
  );
}

export function isMasterlistConfigured(): boolean {
  return Boolean(process.env.MASTERLIST_SUPABASE_URL && key());
}

export function getMasterlistDb(): SupabaseClient {
  if (!isMasterlistConfigured()) {
    throw new Error("Master List Supabase not configured — set MASTERLIST_SUPABASE_URL and a key");
  }
  if (!client) {
    client = createClient(process.env.MASTERLIST_SUPABASE_URL as string, key() as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
