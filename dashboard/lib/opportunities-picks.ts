// "Worth a look" picks over SNAP Opportunities: the CREAM OF THE CROP among the NEW-SNAP
// names + the auctions EXPIRING TODAY. We value a bounded pool of each (by internal quality)
// with the research app's Appraise.net value + TLD-demand count, then keep only the genuine
// bargains — appraisal ÷ cost at or above CREAM_RATIO — best deal first (no fixed top-N).
// Cache-first in research, so re-runs are cheap. If the valuation service is unavailable,
// falls back to a small quality top-N so the digest still shows the best available.

import { newOpportunities, type OpportunitiesReport } from "./opportunities";
import { valuateDomains, type Valuation } from "./research-valuation";
import { afternicBins } from "./afternic-bin";

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

// Selection knobs (tune here / via env after watching a few days of live picks):
//   POOL        — how many candidates per bucket we VALUE (bounds appraisal cost).
//   CREAM_RATIO — appraisal ÷ cost bar to count as a bargain worth surfacing.
//   GEM_RATIO   — the higher bar that earns a 💎 (exceptional bargain) in the message.
//   MIN_PICKS   — always show at least this many per bucket (never a near-empty post).
//   MAX_PICKS   — hard cap per bucket so a bumper day can't flood the channel.
const POOL = Number(process.env.OPPORTUNITY_PICKS_POOL) || 25;
const CREAM_RATIO = Number(process.env.OPPORTUNITY_PICKS_RATIO) || 2;
const GEM_RATIO = Number(process.env.OPPORTUNITY_PICKS_GEM) || 3;
const MIN_PICKS = Number(process.env.OPPORTUNITY_PICKS_MIN) || 5;
const MAX_PICKS = Number(process.env.OPPORTUNITY_PICKS_MAX) || 15;

// Pick the standouts: keep every genuine bargain (ratio ≥ CREAM_RATIO), but ALWAYS surface
// at least MIN_PICKS — if fewer clear the bar, top up with the next-best by value/quality so
// the bucket is never silent (and auctions still posts on a thin day). Capped at MAX_PICKS.
// Rows are already sorted best-value-first, so slicing keeps the best.
function creamOfCrop(rows: Pick[]): Pick[] {
  if (!rows.length) return [];
  const strong = rows.filter((p) => p.ratio != null && p.ratio >= CREAM_RATIO);
  const n = Math.min(Math.max(strong.length, MIN_PICKS), MAX_PICKS);
  return rows.slice(0, n);
}

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

  // "Worth a look" is a value-÷-cost read, so a pick without a price can't be evaluated
  // (and isn't actionable). Require a real price — drops the unpriced feed rows (e.g. the
  // Efty-partner names that come through with no asking price).
  const hasPrice = (x: { price: number | null }): boolean => x.price != null && x.price > 0;

  // Value a POOL of new-snap by internal quality (report.snap is already quality-sorted),
  // priced only — a wider pool than we surface, so the cream isn't capped at a fixed count.
  const snapTop = rep.snap.filter(hasPrice).slice(0, POOL);

  // Value a POOL of auctions expiring TODAY, by internal quality, priced only.
  const auctionTop = rep.auctions
    .filter((a) => endsToday(a.endTimeUtc) && hasPrice(a))
    .sort((a, b) => (b.quality_score ?? -1) - (a.quality_score ?? -1))
    .slice(0, POOL);

  const domains = [...new Set([...snapTop, ...auctionTop].map((d) => String(d.domain).toLowerCase()))];
  const vals = await valuateDomains(domains);
  const valued = vals.size > 0;
  const v = (d: string): Valuation | undefined => vals.get(String(d).toLowerCase());

  // Re-price AFTERNIC-sourced candidates against the LIVE storefront BIN. The feed
  // price can go stale (a seller raises the BIN but our cached feed lags), and a
  // stale-LOW cost manufactures a false value-÷-cost bargain — e.g. sauce.ai was fed
  // $75k while the live Afternic BIN was $295k, turning a 0.6× dud into a fake 2.4×
  // pick. Only the small valued pool is checked; fail-open (no live read → feed price).
  // Other marketplaces keep their feed price — extend here if they show the same drift.
  const isAfternic = (s: string | null): boolean => /afternic/i.test(String(s || ""));
  const afternicDomains = [...snapTop, ...auctionTop]
    .filter((d) => isAfternic(d.source))
    .map((d) => String(d.domain).toLowerCase());
  const liveBins = await afternicBins(afternicDomains);
  const costOf = (d: { domain: string; source: string; price: number | null }): number | null => {
    if (isAfternic(d.source)) {
      const live = liveBins.get(String(d.domain).toLowerCase());
      if (live != null && live > 0) return live;
    }
    return d.price ?? null;
  };

  const snapValued: Pick[] = snapTop.map((d): Pick => {
    const val = v(d.domain);
    const cost = costOf(d);
    return {
      domain: d.domain, bucket: "snap", source: d.source, link: listingUrl(d.domain, d.source, d.link),
      cost, quality_score: d.quality_score ?? null, is_mub: d.is_mub ?? null,
      appraisalMid: val?.appraisalMid ?? null, tldCount: val?.tldCount ?? null, tldBand: val?.tldBand ?? null,
      ratio: ratioOf(val?.appraisalMid ?? null, cost),
    };
  }).sort(byRatioThenQuality);

  const auctionsValued: Pick[] = auctionTop.map((a): Pick => {
    const val = v(a.domain);
    const cost = costOf(a);
    return {
      domain: a.domain, bucket: "auction", source: a.source, link: listingUrl(a.domain, a.source, a.link), endTimeUtc: a.endTimeUtc ?? null,
      cost, quality_score: a.quality_score ?? null, is_mub: a.is_mub ?? null,
      appraisalMid: val?.appraisalMid ?? null, tldCount: val?.tldCount ?? null, tldBand: val?.tldBand ?? null,
      ratio: ratioOf(val?.appraisalMid ?? null, cost),
    };
  }).sort(byRatioThenQuality);

  // Standouts per bucket (bargains first, always ≥ MIN_PICKS, never silent).
  const snap = creamOfCrop(snapValued);
  const auctions = creamOfCrop(auctionsValued);

  return { snap, auctions, valued, generatedAt: new Date().toISOString() };
}

const money = (n: number | null) => (n && n > 0 ? "$" + Math.round(n).toLocaleString() : "—");
// One pick as an mrkdwn line. A 💎 leads a GEM-tier bargain (ratio ≥ GEM_RATIO) so the true
// standouts pop even within the list; everything else gets a plain bullet.
function pickLine(p: Pick): string {
  const gem = p.ratio != null && p.ratio >= GEM_RATIO;
  const val = p.appraisalMid ? `appr ${money(p.appraisalMid)}` : "appr —";
  const ratio = p.ratio != null ? ` · *${p.ratio >= 10 ? Math.round(p.ratio) : p.ratio.toFixed(1)}×* value/cost` : "";
  const tld = p.tldCount != null ? ` · ${p.tldCount} TLDs` : "";
  const nm = p.link ? `<${p.link}|${p.domain}>` : p.domain;
  return `${gem ? "💎" : "•"} ${nm}${p.is_mub ? " ✨" : ""} — cost ${money(p.cost)} · ${val}${ratio}${tld} _(${p.source})_`;
}

// Plain-text digest for ONE bucket (kept for the fallback + tests). null when empty.
export function formatBucketSlack(heading: string, rows: Pick[]): string | null {
  if (!rows.length) return null;
  return [`*${heading}* (appraisal ÷ cost, best first)`, ...rows.map(pickLine)].join("\n");
}

// Rich Slack payload for ONE bucket — a COLORED attachment + a big header block so the
// "worth a look" post stands out in a busy channel (the plain digest just scrolls by).
// Returns { text, attachments } to hand straight to slackPost's opts; null when empty.
export function bucketSlackPayload(
  heading: string,
  rows: Pick[],
  color: string,
): { text: string; attachments: unknown[] } | null {
  if (!rows.length) return null;
  const gems = rows.filter((p) => p.ratio != null && p.ratio >= GEM_RATIO).length;
  const footer = `appraisal ÷ cost · best first${gems ? ` · 💎 = ≥${GEM_RATIO}× bargain` : ""}`;
  return {
    text: `${heading} — ${rows.length} picks`, // notification fallback
    attachments: [
      {
        color,
        blocks: [
          { type: "header", text: { type: "plain_text", text: heading, emoji: true } },
          { type: "section", text: { type: "mrkdwn", text: rows.map(pickLine).join("\n") } },
          { type: "context", elements: [{ type: "mrkdwn", text: footer }] },
        ],
      },
    ],
  };
}
