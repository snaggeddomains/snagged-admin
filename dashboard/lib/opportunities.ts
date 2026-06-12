// New Opportunities — aggregates the "new today" column from every Admin source
// into one report, split into SNAP (new-today domains, with quality/category/price)
// and AUCTIONS (live auctions with price, bids, end time, purchase link). Same data
// the Admin dashboard surfaces per-source, pulled together for an at-a-glance list.

import { loadSources } from "./sources";
import { listNewTodayDomains, listLiveAuctions, type NewTodayDomain, type AuctionListing } from "./new-today";

export type SnapOpportunity = NewTodayDomain & { source: string };
export type AuctionOpportunity = AuctionListing & { source: string };
export type OpportunitiesReport = {
  snap: SnapOpportunity[];
  auctions: AuctionOpportunity[];
  snapSources: number;
  auctionSources: number;
  generatedAt: string;
};

export async function newOpportunities(): Promise<OpportunitiesReport> {
  const sources = await loadSources();
  const snapSrc = sources.filter((s) => s.product === "snap" && s.enabled !== false);
  const aucSrc = sources.filter((s) => s.product === "auctions" && s.enabled !== false);

  // Fan out per-source (best-effort — one source failing doesn't sink the report).
  const snapLists = await Promise.all(
    snapSrc.map(async (s) => {
      try {
        const r = await listNewTodayDomains(s.source_id);
        return r.domains.map((d): SnapOpportunity => ({ ...d, source: s.source_id }));
      } catch {
        return [] as SnapOpportunity[];
      }
    }),
  );
  const aucLists = await Promise.all(
    aucSrc.map(async (s) => {
      try {
        const r = await listLiveAuctions(s.source_id);
        return r.auctions.map((a): AuctionOpportunity => ({ ...a, source: s.source_id }));
      } catch {
        return [] as AuctionOpportunity[];
      }
    }),
  );

  // Snap: dedup by domain (a name "new today" in several feeds appeared once per
  // feed) keeping the cheapest priced instance, then collapse to ONE source — the
  // marketplace the price came from (best_price_source), falling back to the feed
  // that surfaced it when there's no price. Best quality first.
  const byDomain = new Map<string, SnapOpportunity>();
  for (const d of snapLists.flat()) {
    const key = String(d.domain || "").toLowerCase();
    if (!key) continue;
    const cur = byDomain.get(key);
    if (!cur) { byDomain.set(key, d); continue; }
    // Prefer a priced row, and the lower price when both are priced.
    if (cur.price == null && d.price != null) byDomain.set(key, d);
    else if (d.price != null && cur.price != null && d.price < cur.price) byDomain.set(key, d);
  }
  const snap = [...byDomain.values()]
    .map((d): SnapOpportunity => ({ ...d, source: d.best_price_source || d.source }))
    .sort((a, b) => (b.quality_score ?? -1) - (a.quality_score ?? -1));
  // Auctions: soonest-ending first (the countdown matters).
  const auctions = aucLists.flat().sort((a, b) => String(a.endTimeUtc || "~").localeCompare(String(b.endTimeUtc || "~")));

  return {
    snap,
    auctions,
    snapSources: snapSrc.length,
    auctionSources: aucSrc.length,
    generatedAt: new Date().toISOString(),
  };
}
