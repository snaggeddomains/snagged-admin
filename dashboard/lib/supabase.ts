// Service-role Supabase client for the umbrella. Backend-only: RLS is enabled
// on the domain_research_* tables with no policies, so only the service key
// can read them. Never expose this client (or its key) to the browser.
//
// Node runtime only — import from server components / route handlers, NOT from
// middleware (which runs on the Edge).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

function serviceKey(): string | undefined {
  // Mirror research's accepted names.
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
}

export function isDbConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && serviceKey());
}

export function getDb(): SupabaseClient {
  if (!isDbConfigured()) {
    throw new Error(
      "Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  if (!client) {
    client = createClient(process.env.SUPABASE_URL as string, serviceKey() as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
