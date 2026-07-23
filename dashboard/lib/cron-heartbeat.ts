// Cron heartbeat — a tiny "did this scheduled job actually fire?" log. Vercel gives no
// in-app visibility into whether a cron ran, so each cron upserts its row here at the end
// of a run and the UI reads last_run_at to show e.g. "emails auto-synced 40 min ago".
// Best-effort: a missing table / DB never blocks the cron itself.

import { getDb, isDbConfigured } from "./supabase";

const TABLE = "cron_heartbeats";

export type Heartbeat = { name: string; last_run_at: string; last_result: Record<string, unknown> | null };

export async function recordHeartbeat(name: string, result?: Record<string, unknown>): Promise<void> {
  if (!isDbConfigured()) return;
  const now = new Date().toISOString();
  try {
    await getDb().from(TABLE).upsert(
      { name, last_run_at: now, last_result: result ?? null, updated_at: now },
      { onConflict: "name" },
    );
  } catch { /* best-effort — never sink the cron on a heartbeat write */ }
}

export async function getHeartbeat(name: string): Promise<Heartbeat | null> {
  if (!isDbConfigured()) return null;
  try {
    const { data, error } = await getDb().from(TABLE).select("name,last_run_at,last_result").eq("name", name).maybeSingle();
    if (error || !data) return null;
    return data as Heartbeat;
  } catch { return null; }
}
