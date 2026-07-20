// "Worth a look" picks over SNAP Opportunities: the top 5 NEW-SNAP names + the top 5
// auctions EXPIRING TODAY (by our internal quality score), each valued with the research
// app's Appraise.net value + TLD-demand count, then ranked by VALUE ÷ COST descending
// (best deal first). Cheap-ish: at most ~10 appraisals, cache-first in research.

import { newOpportunities, type OpportunitiesReport } from "./opportunities";
import { valuateDomains, type Valuation } from "./research-valuation";

export type Pick = {
  domain: string;
  bucket: "snap" | "auction";
  source: string;
  link: string | null;
  cost: number | null; // snap price / current auction bid
  quality_score: number | null;
  is_mub: boolean | null;
  endTimeUtc?: string | null; // auctions only
  appraisalMid: number | null;
  tldCount: number | null;
  tldBand: string | null;
  ratio: number | null; // appraisal ÷ cost (value for money)
};
export type PicksReport = {
  snap: Pick[];
  auctions: Pick[];
  valued: boolean; // did the research valuation actually run
  generatedAt: string;
};

const TOP_N = 5;

// Link to the actual marketplace LISTING, not the bare domain (Slack would auto-linkify a
// bare domain to the parked site). Prefer a persisted listing URL; else build it from the
// source marketplace; else fall back to the domain. Mirrors the report's snapLink().
function listingUrl(domain: string, source: string | null, persisted?: string | null): string {
  if (persisted && /^https?:\/\//i.test(persisted)) return persisted;
  const s = (source || "").toLowerCase();
  if (s.includes("afternic")) return `https://www.afternic.com/domain/${domain}`;
  if (s.includes("sedo")) return `https://sedo.com/search/?keyword=${encodeURIComponent(domain)}`;
  if (s.includes("atom")) return `https://www.atom.com/name/${domain.charAt(0).toUpperCase()}${domain.slice(1)}`;
  if (s.includes("dan")) return `https://dan.com/buy-domain/${domain}`;
  if (s.includes("efty")) return `https://${domain}`; // Efty landers are served on the domain itself
  return `https://${domain}`;
}

// Is an auction end-time on TODAY's calendar day in America/New_York (our business tz)?
function endsToday(endTimeUtc: string | null | undefined): boolean {
  if (!endTimeUtc) return false;
  const t = Date.parse(endTimeUtc);
  if (Number.isNaN(t)) return false;
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return fmt(new Date(t)) === fmt(new Date());
}

function ratioOf(appraisalMid: number | null, cost: number | null): number | null {
  if (!appraisalMid || appraisalMid <= 0 || !cost || cost <= 0) return null;
  return appraisalMid / cost;
}

// Ranked best-deal-first: priced+valued rows by ratio desc, then the rest (no ratio) by quality.
function byRatioThenQuality(a: Pick, b: Pick): number {
  if (a.ratio != null && b.ratio != null) return b.ratio - a.ratio;
  if (a.ratio != null) return -1;
  if (b.ratio != null) return 1;
  return (b.quality_score ?? -1) - (a.quality_score ?? -1);
}

export async function buildPicks(report?: OpportunitiesReport): Promise<PicksReport> {
  const rep = report || (await newOpportunities());

  // Top 5 new-snap by internal quality (report.snap is already quality-sorted).
  const snapTop = rep.snap.slice(0, TOP_N);

  // Top 5 auctions expiring TODAY, by internal quality.
  const auctionTop = rep.auctions
    .filter((a) => endsToday(a.endTimeUtc))
    .sort((a, b) => (b.quality_score ?? -1) - (a.quality_score ?? -1))
    .slice(0, TOP_N);

  const domains = [...new Set([...snapTop, ...auctionTop].map((d) => String(d.domain).toLowerCase()))];
  const vals = await valuateDomains(domains);
  const valued = vals.size > 0;
  const v = (d: string): Valuation | undefined => vals.get(String(d).toLowerCase());

  const snap: Pick[] = snapTop.map((d): Pick => {
    const val = v(d.domain);
    return {
      domain: d.domain, bucket: "snap", source: d.source, link: listingUrl(d.domain, d.source, d.link),
      cost: d.price ?? null, quality_score: d.quality_score ?? null, is_mub: d.is_mub ?? null,
      appraisalMid: val?.appraisalMid ?? null, tldCount: val?.tldCount ?? null, tldBand: val?.tldBand ?? null,
      ratio: ratioOf(val?.appraisalMid ?? null, d.price ?? null),
    };
  }).sort(byRatioThenQuality);

  const auctions: Pick[] = auctionTop.map((a): Pick => {
    const val = v(a.domain);
    return {
      domain: a.domain, bucket: "auction", source: a.source, link: listingUrl(a.domain, a.source, a.link), endTimeUtc: a.endTimeUtc ?? null,
      cost: a.price ?? null, quality_score: a.quality_score ?? null, is_mub: a.is_mub ?? null,
      appraisalMid: val?.appraisalMid ?? null, tldCount: val?.tldCount ?? null, tldBand: val?.tldBand ?? null,
      ratio: ratioOf(val?.appraisalMid ?? null, a.price ?? null),
    };
  }).sort(byRatioThenQuality);

  return { snap, auctions, valued, generatedAt: new Date().toISOString() };
}

// Slack digest for ONE bucket → its own channel (auctions to the auction Slack, snap to
// the snap Slack). null when the bucket is empty. Ranked best value/cost first.
export function formatBucketSlack(heading: string, rows: Pick[]): string | null {
  if (!rows.length) return null;
  const money = (n: number | null) => (n && n > 0 ? "$" + Math.round(n).toLocaleString() : "—");
  const line = (p: Pick) => {
    const val = p.appraisalMid ? `appr ${money(p.appraisalMid)}` : "appr —";
    const ratio = p.ratio != null ? ` · *${p.ratio >= 10 ? Math.round(p.ratio) : p.ratio.toFixed(1)}×* value/cost` : "";
    const tld = p.tldCount != null ? ` · ${p.tldCount} TLDs` : "";
    const nm = p.link ? `<${p.link}|${p.domain}>` : p.domain;
    return `• ${nm}${p.is_mub ? " ✨" : ""} — cost ${money(p.cost)} · ${val}${ratio}${tld} _(${p.source})_`;
  };
  return [`*${heading}* (appraisal ÷ cost, best first)`, ...rows.map(line)].join("\n");
}
