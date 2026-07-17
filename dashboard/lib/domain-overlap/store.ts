// Persistence for overlap flags (client_domain_overlap_flags, MAIN admin project).
// One row per candidate_domain (the current match set). Re-running the matcher upserts
// the set, PRESERVES dismissals, and reports which candidates are flagged for the first
// time (so the digest only alerts genuinely new matches).

import { getDb, isDbConfigured } from "../supabase";
import type { Flag, MatchEntry } from "./match";

const TABLE = "client_domain_overlap_flags";
const PAGE = 1000;

export type FlagRow = Flag & { run_date: string; dismissed: boolean; last_seen_at: string };

/** Every candidate_domain already flagged (to detect net-new for the digest). */
async function existingCandidates(): Promise<Set<string>> {
  const set = new Set<string>();
  if (!isDbConfigured()) return set;
  const db = getDb();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(TABLE).select("candidate_domain").range(from, from + PAGE - 1);
    if (error) break;
    const rows = data ?? [];
    for (const r of rows) set.add(String((r as { candidate_domain?: unknown }).candidate_domain || "").toLowerCase());
    if (rows.length < PAGE) break;
  }
  return set;
}

/**
 * Upsert the current match set (one row per candidate). `dismissed` + `first_flagged_at`
 * are omitted from the payload so they're preserved on conflict; `last_seen_at` is
 * refreshed. Returns the set of candidate_domains that are NEW this run.
 */
export async function writeFlags(runDate: string, flags: Flag[]): Promise<{ written: number; newDomains: Set<string> }> {
  const newDomains = new Set<string>();
  if (!isDbConfigured() || !flags.length) return { written: 0, newDomains };
  const db = getDb();
  const existing = await existingCandidates();
  for (const f of flags) if (!existing.has(f.candidate_domain.toLowerCase())) newDomains.add(f.candidate_domain);

  const rows = flags.map((f) => ({
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
    last_seen_at: runDate,
  }));
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from(TABLE).upsert(chunk, { onConflict: "candidate_domain" });
    if (error) throw new Error(`flags upsert: ${error.message || error.code || "failed"}`);
    written += chunk.length;
  }
  return { written, newDomains };
}

/** The current flag set for the Reports tab (open only by default). */
export async function listFlags(opts: { includeDismissed?: boolean } = {}): Promise<FlagRow[]> {
  if (!isDbConfigured()) return [];
  let q = getDb()
    .from(TABLE)
    .select("candidate_domain,candidate_sld,candidate_tld,best_tier,clients,matches,source_feed,price,price_source,link,dismissed,first_flagged_at,last_seen_at")
    .order("first_flagged_at", { ascending: false })
    .limit(5000);
  if (!opts.includeDismissed) q = q.eq("dismissed", false);
  const { data, error } = await q;
  if (error) return [];
  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
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
      run_date: row.first_flagged_at ? String(row.first_flagged_at).slice(0, 10) : "",
      last_seen_at: row.last_seen_at ? String(row.last_seen_at).slice(0, 10) : "",
    };
  });
}

/** Dismiss / restore one flag by candidate_domain. */
export async function setFlagDismissed(candidateDomain: string, dismissed: boolean): Promise<boolean> {
  if (!isDbConfigured() || !candidateDomain) return false;
  const { error } = await getDb().from(TABLE).update({ dismissed }).eq("candidate_domain", candidateDomain);
  return !error;
}
