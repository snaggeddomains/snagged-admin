// Persistence for overlap flags (client_domain_overlap_flags, MAIN admin project).
// One row per candidate_domain (the current match set). Re-running the matcher upserts
// the set, PRESERVES dismissals, and reports which candidates are flagged for the first
// time (so the digest only alerts genuinely new matches).

import { getDb, isDbConfigured } from "../supabase";
import type { Flag, MatchEntry } from "./match";

const TABLE = "client_domain_overlap_flags";
const PAGE = 1000;

export type FlagRow = Flag & { run_date: string; dismissed: boolean; last_seen_at: string };
const LIST_PAGE = 1000;

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
    kind: f.kind,
    ends_at: f.ends_at,
    last_seen_at: runDate,
  }));
  let written = 0;
  let dropKind = false; // set if the kind/ends_at columns aren't migrated yet
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const payload = dropKind
      ? chunk.map((row) => {
          const rest: Record<string, unknown> = { ...row };
          delete rest.kind;
          delete rest.ends_at;
          return rest;
        })
      : chunk;
    const { error } = await db.from(TABLE).upsert(payload, { onConflict: "candidate_domain" });
    if (error) {
      // Column not migrated → strip kind/ends_at and retry this chunk (degrade gracefully).
      const missingCol = /kind|ends_at|column/i.test(String(error.message || "")) || error.code === "PGRST204" || error.code === "42703";
      if (!dropKind && missingCol) { dropKind = true; i -= 500; continue; }
      throw new Error(`flags upsert: ${error.message || error.code || "failed"}`);
    }
    written += chunk.length;
  }
  return { written, newDomains };
}

/** The full current flag set for the Reports tab. PostgREST caps a single response at
 *  ~1000 rows, so page through with .range() (the match set is > 1000). */
export async function listFlags(opts: { includeDismissed?: boolean } = {}): Promise<FlagRow[]> {
  if (!isDbConfigured()) return [];
  const db = getDb();
  const FULL = "candidate_domain,candidate_sld,candidate_tld,best_tier,clients,matches,source_feed,price,price_source,link,kind,ends_at,dismissed,first_flagged_at,last_seen_at";
  const LEGACY = "candidate_domain,candidate_sld,candidate_tld,best_tier,clients,matches,source_feed,price,price_source,link,dismissed,first_flagged_at,last_seen_at";
  const out: FlagRow[] = [];
  let cols = FULL; // fall back to LEGACY if kind/ends_at aren't migrated
  for (let from = 0; ; from += LIST_PAGE) {
    let q = db
      .from(TABLE)
      .select(cols)
      .order("first_flagged_at", { ascending: false })
      .range(from, from + LIST_PAGE - 1);
    if (!opts.includeDismissed) q = q.eq("dismissed", false);
    const { data, error } = await q;
    if (error && cols === FULL && (/kind|ends_at|column/i.test(String(error.message || "")) || error.code === "PGRST204" || error.code === "42703")) {
      cols = LEGACY; from -= LIST_PAGE; continue; // retry this page without the new columns
    }
    if (error) break;
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    for (const row of rows) {
      out.push({
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
        kind: row.kind === "auction" ? "auction" : "sale",
        ends_at: row.ends_at != null ? String(row.ends_at) : null,
        dismissed: Boolean(row.dismissed),
        run_date: row.first_flagged_at ? String(row.first_flagged_at).slice(0, 10) : "",
        last_seen_at: row.last_seen_at ? String(row.last_seen_at).slice(0, 10) : "",
      });
    }
    if (rows.length < LIST_PAGE) break;
  }
  return out;
}

/** Dismiss / restore one flag by candidate_domain. */
export async function setFlagDismissed(candidateDomain: string, dismissed: boolean): Promise<boolean> {
  if (!isDbConfigured() || !candidateDomain) return false;
  const { error } = await getDb().from(TABLE).update({ dismissed }).eq("candidate_domain", candidateDomain);
  return !error;
}
