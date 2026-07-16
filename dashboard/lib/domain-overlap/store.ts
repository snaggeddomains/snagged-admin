// Persistence for overlap flags (client_domain_overlap_flags, MAIN admin project).

import { getDb, isDbConfigured } from "../supabase";
import type { Flag, MatchEntry } from "./match";

const TABLE = "client_domain_overlap_flags";

export type FlagRow = Flag & { id: string; run_date: string; dismissed: boolean; created_at: string };

/** Upsert the run's flags (one row per candidate; re-runs on the same day replace). */
export async function writeFlags(runDate: string, flags: Flag[]): Promise<number> {
  if (!isDbConfigured() || !flags.length) return 0;
  const db = getDb();
  const rows = flags.map((f) => ({
    run_date: runDate,
    candidate_domain: f.candidate_domain,
    candidate_sld: f.candidate_sld,
    candidate_tld: f.candidate_tld,
    best_tier: f.best_tier,
    clients: f.clients,
    matches: f.matches,
    source_feed: f.source_feed,
    price: f.price,
    price_source: f.price_source,
    link: f.link,
  }));
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from(TABLE).upsert(chunk, { onConflict: "run_date,candidate_domain" });
    if (error) throw new Error(`flags upsert: ${error.message || error.code || "failed"}`);
    n += chunk.length;
  }
  return n;
}

/** Flags for the Reports tab (default: last 30 days, open only). */
export async function listFlags(opts: { days?: number; includeDismissed?: boolean } = {}): Promise<FlagRow[]> {
  if (!isDbConfigured()) return [];
  const days = opts.days ?? 30;
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  let q = getDb()
    .from(TABLE)
    .select("id,run_date,candidate_domain,candidate_sld,candidate_tld,best_tier,clients,matches,source_feed,price,price_source,link,dismissed,created_at")
    .gte("run_date", since)
    .order("run_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(5000);
  if (!opts.includeDismissed) q = q.eq("dismissed", false);
  const { data, error } = await q;
  if (error) return [];
  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      run_date: String(row.run_date).slice(0, 10),
      candidate_domain: String(row.candidate_domain),
      candidate_sld: String(row.candidate_sld),
      candidate_tld: String(row.candidate_tld),
      best_tier: (row.best_tier === "exact_tld" ? "exact_tld" : "affix") as "exact_tld" | "affix",
      clients: Array.isArray(row.clients) ? (row.clients as string[]) : [],
      matches: Array.isArray(row.matches) ? (row.matches as MatchEntry[]) : [],
      source_feed: row.source_feed != null ? String(row.source_feed) : null,
      price: typeof row.price === "number" ? row.price : row.price != null ? Number(row.price) : null,
      price_source: row.price_source != null ? String(row.price_source) : null,
      link: row.link != null ? String(row.link) : null,
      dismissed: Boolean(row.dismissed),
      created_at: String(row.created_at),
    };
  });
}

/** Dismiss / restore one flag. */
export async function setFlagDismissed(id: string, dismissed: boolean): Promise<boolean> {
  if (!isDbConfigured() || !id) return false;
  const { error } = await getDb().from(TABLE).update({ dismissed }).eq("id", id);
  return !error;
}
