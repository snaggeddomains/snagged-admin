// Resolve the actual domains a source added "new today" so the admin dashboard
// can show the names behind the "new today" count (mirrors the imports
// drill-down). Two sources of truth, in priority order:
//
//   1. FEED-new (authoritative): the list the source persisted at run time to
//      state/<source>/new_today.json — exactly the names counted by new_count.
//   2. UNIVERSE-new (fallback): name_universe rows with first_seen = today that
//      carry this source. Faithful for tier-1 owned-sheet sources (whose
//      new_count IS the universe net-new); an approximation for any source not
//      yet persisting a feed list.
//
// Either way, each name is joined to its name_universe enrichment
// (quality_score / category) so the table matches the uploader's drill-down.

import { getFile } from "./github";
import { getNamingDb, isNamingConfigured } from "./naming";

export type NewTodayDomain = {
  domain: string;
  quality_score: number | null;
  category: string | null; // null = in universe but not yet LLM-enriched
  enriched: boolean;
};

export type NewTodayResult = {
  source: string;
  origin: "feed" | "universe" | "none";
  domains: NewTodayDomain[];
};

const DISPLAY_CAP = 500;
const IN_CHUNK = 150; // keep the IN(...) URL well under length limits

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Look up quality_score/category for a set of domains in name_universe. */
async function enrichmentFor(
  domains: string[],
): Promise<Map<string, { q: number | null; c: string | null }>> {
  const map = new Map<string, { q: number | null; c: string | null }>();
  if (!domains.length || !isNamingConfigured()) return map;
  const db = getNamingDb();
  for (let i = 0; i < domains.length; i += IN_CHUNK) {
    const chunk = domains.slice(i, i + IN_CHUNK);
    const { data, error } = await db
      .from("name_universe")
      .select("domain,quality_score,category")
      .in("domain", chunk);
    if (error) throw new Error(`new-today enrichment: ${error.message || error.code || "request failed"}`);
    for (const r of data ?? []) {
      const row = r as { domain?: unknown; quality_score?: unknown; category?: unknown };
      map.set(String(row.domain || "").toLowerCase(), {
        q: typeof row.quality_score === "number" ? row.quality_score : null,
        c: row.category != null ? String(row.category) : null,
      });
    }
  }
  return map;
}

export async function listNewTodayDomains(sourceId: string): Promise<NewTodayResult> {
  // 1) Authoritative feed-new list, if the source persisted one this run.
  let feedDomains: string[] | null = null;
  try {
    const raw = await getFile(`state/${sourceId}/new_today.json`);
    if (raw) {
      const j = JSON.parse(raw) as { domains?: unknown };
      if (Array.isArray(j.domains)) {
        feedDomains = j.domains.map((d) => String(d).toLowerCase()).filter(Boolean);
      }
    }
  } catch {
    // Malformed/missing — fall through to the universe query.
  }

  if (feedDomains) {
    const domains = feedDomains.slice(0, DISPLAY_CAP);
    const enr = await enrichmentFor(domains);
    const out: NewTodayDomain[] = domains.map((d) => {
      const e = enr.get(d);
      return {
        domain: d,
        quality_score: e?.q ?? null,
        category: e?.c ?? null,
        enriched: e?.c != null,
      };
    });
    out.sort((a, b) => (b.quality_score ?? -1) - (a.quality_score ?? -1));
    return { source: sourceId, origin: "feed", domains: out };
  }

  // 2) Fallback: net-new to the universe today via this source.
  if (!isNamingConfigured()) return { source: sourceId, origin: "none", domains: [] };
  const db = getNamingDb();
  const { data, error } = await db
    .from("name_universe")
    .select("domain,quality_score,category")
    .contains("sources", [sourceId])
    .gte("first_seen", todayUTC())
    .order("quality_score", { ascending: false, nullsFirst: false })
    .limit(DISPLAY_CAP);
  if (error) throw new Error(`new-today universe: ${error.message || error.code || "request failed"}`);
  const out: NewTodayDomain[] = (data ?? []).map((r) => {
    const row = r as { domain?: unknown; quality_score?: unknown; category?: unknown };
    const category = row.category != null ? String(row.category) : null;
    return {
      domain: String(row.domain || ""),
      quality_score: typeof row.quality_score === "number" ? row.quality_score : null,
      category,
      enriched: category != null,
    };
  });
  return { source: sourceId, origin: "universe", domains: out };
}
