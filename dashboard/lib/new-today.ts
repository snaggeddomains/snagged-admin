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
  price: number | null;
  best_price_source: string | null; // which marketplace the price came from
};

export type NewTodayResult = {
  source: string;
  origin: "feed" | "universe" | "none";
  domains: NewTodayDomain[];
};

// A single live auction from a source's snapshot.json (the current qualifying
// set the auctions watchlist publishes). Auction names deliberately do NOT enter
// name_universe / get enriched (only SNAP does), so they have no quality/category
// — the drill-down shows the auction facts instead (price, end time, link).
export type AuctionListing = {
  domain: string;
  price: number | null;
  endTimeUtc: string | null;
  bidCount: number | null;
  link: string | null;
};

export type LiveAuctionsResult = {
  source: string;
  auctions: AuctionListing[];
};

const DISPLAY_CAP = 500;
const IN_CHUNK = 150; // keep the IN(...) URL well under length limits

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Look up quality_score/category for a set of domains in name_universe. */
type Enr = { q: number | null; c: string | null; price: number | null; ps: string | null };
async function enrichmentFor(domains: string[]): Promise<Map<string, Enr>> {
  const map = new Map<string, Enr>();
  if (!domains.length || !isNamingConfigured()) return map;
  const db = getNamingDb();
  for (let i = 0; i < domains.length; i += IN_CHUNK) {
    const chunk = domains.slice(i, i + IN_CHUNK);
    const { data, error } = await db
      .from("name_universe")
      .select("domain,quality_score,category,best_price,best_price_source")
      .in("domain", chunk);
    if (error) throw new Error(`new-today enrichment: ${error.message || error.code || "request failed"}`);
    for (const r of data ?? []) {
      const row = r as { domain?: unknown; quality_score?: unknown; category?: unknown; best_price?: unknown; best_price_source?: unknown };
      map.set(String(row.domain || "").toLowerCase(), {
        q: typeof row.quality_score === "number" ? row.quality_score : null,
        c: row.category != null ? String(row.category) : null,
        price: typeof row.best_price === "number" ? row.best_price : null,
        ps: row.best_price_source != null ? String(row.best_price_source) : null,
      });
    }
  }
  return map;
}

// Live auctions for an auction-product source, straight from its snapshot.json
// (every auction source persists one: { domain, end_time_utc, price, bid_count,
// link }). This is the same set the Slack watchlist reports — NOT the run delta
// (new_count) and NOT a universe query. Best-effort: missing/malformed → [].
export async function listLiveAuctions(sourceId: string): Promise<LiveAuctionsResult> {
  let raw: string | null = null;
  try {
    raw = await getFile(`state/${sourceId}/snapshot.json`);
  } catch {
    raw = null;
  }
  if (!raw) return { source: sourceId, auctions: [] };
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return { source: sourceId, auctions: [] };
  }
  if (!Array.isArray(arr)) return { source: sourceId, auctions: [] };
  const auctions: AuctionListing[] = [];
  for (const it of arr) {
    const r = it as Record<string, unknown>;
    const domain = String(r.domain || "").toLowerCase();
    if (!domain) continue;
    auctions.push({
      domain,
      price: typeof r.price === "number" ? r.price : null,
      endTimeUtc: r.end_time_utc != null ? String(r.end_time_utc) : null,
      bidCount: typeof r.bid_count === "number" ? r.bid_count : null,
      link: r.link != null ? String(r.link) : null,
    });
  }
  // Soonest-ending first (snapshots are already sorted this way, but be safe).
  auctions.sort((a, b) => String(a.endTimeUtc || "").localeCompare(String(b.endTimeUtc || "")));
  return { source: sourceId, auctions: auctions.slice(0, DISPLAY_CAP) };
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
        price: e?.price ?? null,
        best_price_source: e?.ps ?? null,
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
    .select("domain,quality_score,category,best_price,best_price_source")
    .contains("sources", [sourceId])
    .gte("first_seen", todayUTC())
    .order("quality_score", { ascending: false, nullsFirst: false })
    .limit(DISPLAY_CAP);
  if (error) throw new Error(`new-today universe: ${error.message || error.code || "request failed"}`);
  const out: NewTodayDomain[] = (data ?? []).map((r) => {
    const row = r as { domain?: unknown; quality_score?: unknown; category?: unknown; best_price?: unknown; best_price_source?: unknown };
    const category = row.category != null ? String(row.category) : null;
    return {
      domain: String(row.domain || ""),
      quality_score: typeof row.quality_score === "number" ? row.quality_score : null,
      category,
      enriched: category != null,
      price: typeof row.best_price === "number" ? row.best_price : null,
      best_price_source: row.best_price_source != null ? String(row.best_price_source) : null,
    };
  });
  return { source: sourceId, origin: "universe", domains: out };
}
