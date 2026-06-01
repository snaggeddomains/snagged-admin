// Service-role client for the SEPARATE Supabase project that hosts the naming
// universe (name_universe). Backend-only. Distinct from lib/supabase.ts (the
// umbrella's main DB). Used by the Admin Imports tool to upsert into Universe.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

function key(): string | undefined {
  return process.env.SUPABASE_NAMING_SERVICE_KEY || process.env.SUPABASE_NAMING_SECRET_KEY;
}

export function isNamingConfigured(): boolean {
  return Boolean(process.env.SUPABASE_NAMING_URL && key());
}

export function getNamingDb(): SupabaseClient {
  if (!isNamingConfigured()) {
    throw new Error("Naming Supabase not configured — set SUPABASE_NAMING_URL and SUPABASE_NAMING_SERVICE_KEY");
  }
  if (!client) {
    client = createClient(process.env.SUPABASE_NAMING_URL as string, key() as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
