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
  num_words: number | null; // from universe (1 = one-word); null when not in universe
  is_mub: boolean | null; // MUB (made-up brandable) flag, precomputed by the pipeline
  link?: string | null; // direct listing URL when the source persisted one (state/<source>/links.json)
};

export type NewTodayResult = {
  source: string;
  origin: "feed" | "universe" | "none";
  domains: NewTodayDomain[];
};

// A single live auction from a source's snapshot.json (the current qualifying
// set the auctions watchlist publishes). Auction names deliberately do NOT enter
// name_universe / get enriched (only SNAP does), so the drill-down shows the
// auction facts (price, end time, link). We DO best-effort attach the pipeline
// `quality_score` for any auction name that ALSO happens to live in name_universe
// (from a marketplace feed) — same number SNAP shows; null when the name isn't
// in the universe.
export type AuctionListing = {
  domain: string;
  price: number | null;
  endTimeUtc: string | null;
  bidCount: number | null;
  link: string | null;
  quality_score: number | null;
  num_words: number | null; // from universe (1 = one-word); null when not in universe
  is_mub: boolean | null; // MUB flag from the producer's snapshot (pipeline-precomputed)
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

/** Look up quality_score/category/num_words for a set of domains in name_universe. */
type Enr = { q: number | null; c: string | null; price: number | null; ps: string | null; nw: number | null };
async function enrichmentFor(domains: string[]): Promise<Map<string, Enr>> {
  const map = new Map<string, Enr>();
  if (!domains.length || !isNamingConfigured()) return map;
  const db = getNamingDb();
  for (let i = 0; i < domains.length; i += IN_CHUNK) {
    const chunk = domains.slice(i, i + IN_CHUNK);
    const { data, error } = await db
      .from("name_universe")
      .select("domain,quality_score,category,best_price,best_price_source,num_words")
      .in("domain", chunk);
    if (error) throw new Error(`new-today enrichment: ${error.message || error.code || "request failed"}`);
    for (const r of data ?? []) {
      const row = r as { domain?: unknown; quality_score?: unknown; category?: unknown; best_price?: unknown; best_price_source?: unknown; num_words?: unknown };
      map.set(String(row.domain || "").toLowerCase(), {
        q: typeof row.quality_score === "number" ? row.quality_score : null,
        c: row.category != null ? String(row.category) : null,
        price: typeof row.best_price === "number" ? row.best_price : null,
        ps: row.best_price_source != null ? String(row.best_price_source) : null,
        nw: typeof row.num_words === "number" ? row.num_words : null,
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
    const domain = String(r.domain || "").trim().toLowerCase();
    if (!domain) continue;
    auctions.push({
      domain,
      price: typeof r.price === "number" ? r.price : null,
      endTimeUtc: r.end_time_utc != null ? String(r.end_time_utc) : null,
      bidCount: typeof r.bid_count === "number" ? r.bid_count : null,
      link: r.link != null ? String(r.link) : null,
      quality_score: null,
      num_words: null,
      // MUB is precomputed by the producer into the snapshot row (null on rows
      // written before the pipeline started annotating).
      is_mub: typeof r.is_mub === "boolean" ? r.is_mub : null,
    });
  }
  // Soonest-ending first (snapshots are already sorted this way, but be safe).
  auctions.sort((a, b) => String(a.endTimeUtc || "").localeCompare(String(b.endTimeUtc || "")));
  const shown = auctions.slice(0, DISPLAY_CAP);
  // Best-effort: attach the same quality_score + num_words (one-word) SNAP shows
  // for any auction name that also exists in name_universe. Not-in-universe → null.
  try {
    const enr = await enrichmentFor(shown.map((a) => a.domain));
    for (const a of shown) {
      const e = enr.get(a.domain);
      a.quality_score = e?.q ?? null;
      a.num_words = e?.nw ?? null;
    }
  } catch {
    // Enrichment lookup failed — leave scores null, still return the auctions.
  }
  return { source: sourceId, auctions: shown };
}

// Direct per-domain listing URLs a source persisted this run
// (state/<source>/links.json = { "<domain>": "<url>", ... }). Best-effort: most
// sources don't write one, so a miss just means no deep link.
async function feedLinks(sourceId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const raw = await getFile(`state/${sourceId}/links.json`);
    if (raw) {
      const j = JSON.parse(raw) as Record<string, unknown>;
      for (const [d, u] of Object.entries(j)) {
        if (typeof u === "string" && u) map.set(String(d).toLowerCase(), u);
      }
    }
  } catch {
    // Missing/malformed — no deep links for this source.
  }
  return map;
}

// The source's own captured asking price per domain
// (state/<source>/snapshot.json = { "<domain>": <price|null> }). For listings not
// in name_universe (e.g. NamePros), this is the only price we have, so prefer it.
async function feedPrices(sourceId: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const raw = await getFile(`state/${sourceId}/snapshot.json`);
    if (raw) {
      const j = JSON.parse(raw) as Record<string, unknown>;
      for (const [d, p] of Object.entries(j)) {
        if (typeof p === "number" && p > 0) map.set(String(d).toLowerCase(), p);
      }
    }
  } catch {
    // Missing/malformed — fall back to universe price.
  }
  return map;
}

export async function listNewTodayDomains(sourceId: string): Promise<NewTodayResult> {
  // 1) Authoritative feed-new list, if the source persisted one this run.
  let feedDomains: string[] | null = null;
  let feedMub: Set<string> | null = null; // MUB subset persisted alongside the domains
  try {
    const raw = await getFile(`state/${sourceId}/new_today.json`);
    if (raw) {
      const j = JSON.parse(raw) as { domains?: unknown; mub?: unknown };
      if (Array.isArray(j.domains)) {
        feedDomains = j.domains.map((d) => String(d).toLowerCase()).filter(Boolean);
      }
      if (Array.isArray(j.mub)) {
        feedMub = new Set(j.mub.map((d) => String(d).toLowerCase()));
      }
    }
  } catch {
    // Malformed/missing — fall through to the universe query.
  }

  if (feedDomains) {
    const domains = feedDomains.slice(0, DISPLAY_CAP);
    const enr = await enrichmentFor(domains);
    const links = await feedLinks(sourceId);   // direct listing URLs, if persisted
    const prices = await feedPrices(sourceId); // the source's own asking price, if persisted
    const out: NewTodayDomain[] = domains.map((d) => {
      const e = enr.get(d);
      const askPrice = prices.get(d) ?? null; // the listing's own asking price
      return {
        domain: d,
        quality_score: e?.q ?? null,
        category: e?.c ?? null,
        enriched: e?.c != null,
        price: askPrice ?? e?.price ?? null,
        best_price_source: askPrice != null ? sourceId : (e?.ps ?? null),
        num_words: e?.nw ?? null,
        is_mub: feedMub ? feedMub.has(d) : null,
        link: links.get(d) ?? null,
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
    .select("domain,quality_score,category,best_price,best_price_source,num_words")
    .contains("sources", [sourceId])
    .gte("first_seen", todayUTC())
    .order("quality_score", { ascending: false, nullsFirst: false })
    .limit(DISPLAY_CAP);
  if (error) throw new Error(`new-today universe: ${error.message || error.code || "request failed"}`);
  const out: NewTodayDomain[] = (data ?? []).map((r) => {
    const row = r as { domain?: unknown; quality_score?: unknown; category?: unknown; best_price?: unknown; best_price_source?: unknown; num_words?: unknown };
    const category = row.category != null ? String(row.category) : null;
    return {
      domain: String(row.domain || ""),
      quality_score: typeof row.quality_score === "number" ? row.quality_score : null,
      category,
      enriched: category != null,
      price: typeof row.best_price === "number" ? row.best_price : null,
      best_price_source: row.best_price_source != null ? String(row.best_price_source) : null,
      num_words: typeof row.num_words === "number" ? row.num_words : null,
      is_mub: null, // fallback path doesn't have the feed's MUB set
    };
  });
  return { source: sourceId, origin: "universe", domains: out };
}
