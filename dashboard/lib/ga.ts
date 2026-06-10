// Google Analytics 4 (Data API) client — server-only.
//
// Auth: a Google service account (the `marketplace-pipeline` SA) granted Viewer on
// the GA4 property; token minting lives in lib/google-auth.ts (shared with Sheets).
//
// Env (set in the snagged-admin Vercel project — NOT just the sandbox):
//   GA4_PROPERTY_ID   e.g. "420532804" (bare number; we prefix "properties/")
//   GOOGLE_SA_KEY / GOOGLE_SA_KEY_B64   service-account JSON (see google-auth.ts)
//
// `analyticsReport(tranche, from, to)` runs the segmented queries the Site
// Analytics page needs. Three tranches share snagged.com:
//   • marketplace = /domains/*        (type-in domain buyers)
//   • blog/SEO    = /post|/blog|/guides (content driving organic traffic)
//   • core        = everything else   (the services / sell-side site)
// Submission counts + the source/intent/budget breakdowns blend GA (forward) with
// the bundled historical Formspark export (pre-GA-tracking) — see lib/historical.ts.

import { googleAccessToken } from "./google-auth";
import { historicalCount, historicalBreakdown, mergeLabelValues } from "./historical";

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const FUNNEL_API = "https://analyticsdata.googleapis.com/v1alpha";

const MKT_PREFIX = "/domains/"; // marketplace listing namespace
const BLOG_PREFIXES = ["/post/", "/blog", "/guides/"]; // SEO content namespaces

function propertyPath(): string {
  const p = (process.env.GA4_PROPERTY_ID || "").trim();
  if (!p) throw new Error("GA4_PROPERTY_ID is not set");
  return p.startsWith("properties/") ? p : `properties/${p}`;
}

// True when the deployment can talk to GA — so the page renders a friendly
// "not configured" state instead of throwing.
export function gaConfigured(): boolean {
  return Boolean((process.env.GOOGLE_SA_KEY || process.env.GOOGLE_SA_KEY_B64) && process.env.GA4_PROPERTY_ID);
}

// ── Low-level reports ────────────────────────────────────────────────────────
type GaRow = { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] };
type GaReport = { rows?: GaRow[]; rowCount?: number };

export async function runReport(body: Record<string, unknown>): Promise<GaReport> {
  const token = await googleAccessToken(SCOPE);
  const res = await fetch(`${DATA_API}/${propertyPath()}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GA runReport ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as GaReport;
}

type FunnelResponse = { funnelTable?: { rows?: GaRow[] } };
async function runFunnelReport(body: Record<string, unknown>): Promise<FunnelResponse> {
  const token = await googleAccessToken(SCOPE);
  const res = await fetch(`${FUNNEL_API}/${propertyPath()}:runFunnelReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GA runFunnelReport ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as FunnelResponse;
}

// ── Filter helpers ───────────────────────────────────────────────────────────
const beginsWith = (fieldName: string, value: string) => ({ filter: { fieldName, stringFilter: { matchType: "BEGINS_WITH", value } } });
const exact = (fieldName: string, value: string) => ({ filter: { fieldName, stringFilter: { value } } });
const not = (e: unknown) => ({ notExpression: e });
const and = (...exprs: unknown[]) => ({ andGroup: { expressions: exprs } });
const or = (...exprs: unknown[]) => ({ orGroup: { expressions: exprs } });

const blogLanding = () => or(...BLOG_PREFIXES.map((p) => beginsWith("landingPagePlusQueryString", p)));
const blogPagePath = () => or(...BLOG_PREFIXES.map((p) => beginsWith("pagePath", p)));

// A session-scoped segment by where the session LANDED. Marketplace = /domains/*,
// blog = the SEO namespaces, core = neither.
function landingSegment(tranche: Tranche): unknown {
  const mkt = beginsWith("landingPagePlusQueryString", MKT_PREFIX);
  if (tranche === "marketplace") return mkt;
  if (tranche === "blog") return blogLanding();
  return and(not(mkt), not(blogLanding())); // core
}

const n = (v?: string) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const rowsOf = (r: GaReport) => r.rows || [];
const firstMetric = (r: GaReport, i = 0) => n(rowsOf(r)[0]?.metricValues?.[i]?.value);
const ymd = (raw: string) => (/^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw);
// Run a report but never throw — for custom-dimension queries that may not be
// registered yet (GA 400s an unregistered customEvent:*). Returns [] on failure.
async function safeRows(body: Record<string, unknown>): Promise<GaRow[]> {
  try { return rowsOf(await runReport(body)); } catch { return []; }
}
const inList = (fieldName: string, values: string[]) => ({ filter: { fieldName, inListFilter: { values } } });
// /domains/<slug> → domain. The slug replaces dots with hyphens and the TLD is the
// last hyphen segment: "actionable-com" → "actionable.com", "natural-products-com"
// → "natural-products.com", "edms-net" → "edms.net".
const slugToDomain = (slug: string) => slug.replace(/-([a-z0-9]+)$/i, ".$1");
const slugOf = (path: string) => path.replace(/^\/domains\//, "").replace(/\/$/, "");
// Best-effort: the live /marketplace page's /domains/<slug> links, so zero-traffic
// listings still appear in the table. Falls back to the GA-trafficked set on error.
// The current marketplace listing domains (slug → domain), for joins (e.g. the
// newsletter-feature scan only counts domains that are live listings).
export async function marketplaceListingDomains(): Promise<string[]> {
  const slugs = await marketplaceInventory();
  return [...new Set(slugs.map(slugToDomain))];
}
async function marketplaceInventory(): Promise<string[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch("https://www.snagged.com/marketplace", { signal: ctrl.signal, headers: { "user-agent": "snagged-admin/analytics" } });
    clearTimeout(timer);
    const html = await res.text();
    const slugs = [...html.matchAll(/href="\/domains\/([a-z0-9-]+)"/gi)].map((m) => m[1].toLowerCase());
    return [...new Set(slugs)];
  } catch { return []; }
}
const channelRows = (r: GaReport): ChannelRow[] => rowsOf(r).map((x) => ({
  channel: x.dimensionValues?.[0]?.value || "(none)", sessions: n(x.metricValues?.[0]?.value), users: n(x.metricValues?.[1]?.value),
}));
const sourceRows = (r: GaReport): SourceRow[] => rowsOf(r).map((x) => ({
  source: x.dimensionValues?.[0]?.value || "(none)", medium: x.dimensionValues?.[1]?.value || "(none)", sessions: n(x.metricValues?.[0]?.value),
}));
const trendRows = (r: GaReport): TrendRow[] => rowsOf(r).map((x) => ({
  date: ymd(x.dimensionValues?.[0]?.value || ""), sessions: n(x.metricValues?.[0]?.value), pageviews: n(x.metricValues?.[1]?.value),
}));
// [dimension, eventCount] rows → {label, value}[], dropping GA's empty buckets.
function toLV(rows: GaRow[]): LabelValue[] {
  return rows
    .map((r) => ({ label: r.dimensionValues?.[0]?.value || "(none)", value: n(r.metricValues?.[0]?.value) }))
    .filter((x) => x.label !== "(not set)" && x.label !== "(none)");
}

// Sitewide daily sessions split by default channel group, over [from, to]. Powers
// the Ad Lift (incrementality) model in lib/xads.ts: comparing channel traffic on
// X-ad-running days vs dark days. Sitewide (no landing segment) — promoted-post
// brand lift isn't confined to one business line.
export type DailyChannelRow = { date: string; channel: string; sessions: number };
export async function dailyChannelSessions(from: string, to: string): Promise<DailyChannelRow[]> {
  const r = await runReport({
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }],
    limit: 100000,
  });
  return rowsOf(r).map((x) => ({
    date: ymd(x.dimensionValues?.[0]?.value || ""),
    channel: x.dimensionValues?.[1]?.value || "(none)",
    sessions: n(x.metricValues?.[0]?.value),
  }));
}

// ── Typed report shapes the client renders ──────────────────────────────────
export type StatBlock = { sessions: number; users: number; pageviews: number; submissions: number };
export type ChannelRow = { channel: string; sessions: number; users: number };
export type PageRow = { path: string; views: number; users: number };
export type SourceRow = { source: string; medium: string; sessions: number };
export type LabelValue = { label: string; value: number };
export type TrendRow = { date: string; sessions: number; pageviews: number };
export type FunnelStep = { name: string; users: number };

// One row per marketplace listing (/domains/<slug>), GA metrics joined per domain.
export type ListingRow = {
  domain: string; path: string; views: number; sessions: number; users: number;
  inquiryStarts: number; clicks: number; inquiries: number;
};
export type MarketplaceReport = { tranche: "marketplace"; summary: StatBlock; topPages: PageRow[]; listings: ListingRow[]; channels: ChannelRow[]; trend: TrendRow[] };
export type CoreReport = {
  tranche: "core"; summary: StatBlock; channels: ChannelRow[]; sources: SourceRow[];
  submissionsByChannel: LabelValue[]; selfReportedSource: LabelValue[]; leadIntent: LabelValue[]; leadBudget: LabelValue[]; trend: TrendRow[];
};
export type BlogReport = {
  tranche: "blog"; summary: StatBlock; topPosts: PageRow[]; channels: ChannelRow[]; sources: SourceRow[]; funnel: FunnelStep[]; trend: TrendRow[];
};
export type GaTrancheReport = MarketplaceReport | CoreReport | BlogReport;
export type Tranche = "marketplace" | "core" | "blog";

// The GA4 conversion event per flow (blog leads are generate_lead too).
const SUBMIT_EVENT: Record<Tranche, string> = { marketplace: "marketplace_inquiry", core: "generate_lead", blog: "generate_lead" };

// Blog → main site → submission funnel (GA4 v1alpha funnel API). Returns the 3
// ordered steps with active-user counts; [] if the funnel API errors.
async function blogToSiteFunnel(from: string, to: string): Promise<FunnelStep[]> {
  const names = ["Entered on blog", "Reached the main site", "Submitted a lead"];
  try {
    const d = await runFunnelReport({
      dateRanges: [{ startDate: from, endDate: to }],
      funnel: {
        steps: [
          // Step 1 keys on landingPagePlusQueryString so it's the session ENTRY —
          // blog/SEO was the way in, not a page they hit later (e.g. via newsletter).
          // That's the "is SEO discovery driving conversions" question. RE2 (no
          // lookahead); step 2 = the homepage (unifiedPagePathScreen is the in-funnel
          // page field).
          { name: names[0], filterExpression: { funnelFieldFilter: { fieldName: "landingPagePlusQueryString", stringFilter: { matchType: "PARTIAL_REGEXP", value: "^/(post/|blog)" } } } },
          { name: names[1], filterExpression: { funnelFieldFilter: { fieldName: "unifiedPagePathScreen", stringFilter: { matchType: "EXACT", value: "/" } } } },
          { name: names[2], filterExpression: { funnelEventFilter: { eventName: "generate_lead" } } },
        ],
      },
    });
    const byStep = new Map<number, number>();
    for (const r of d.funnelTable?.rows || []) {
      const m = (r.dimensionValues?.[0]?.value || "").match(/^(\d+)\./);
      if (m) byStep.set(Number(m[1]), n(r.metricValues?.[0]?.value));
    }
    return names.map((name, i) => ({ name, users: byStep.get(i + 1) || 0 }));
  } catch {
    return [];
  }
}

// Run all queries for one tranche over an ET day range [from, to] (YYYY-MM-DD;
// GA interprets these in the property timezone, America/New_York).
export async function analyticsReport(tranche: Tranche, from: string, to: string): Promise<GaTrancheReport> {
  const dateRanges = [{ startDate: from, endDate: to }];
  const seg = landingSegment(tranche);

  const summaryReq = runReport({ dateRanges, metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }], dimensionFilter: seg });
  const submitReq = runReport({ dateRanges, dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: and(seg, exact("eventName", SUBMIT_EVENT[tranche])) });
  const channelReq = runReport({ dateRanges, dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }, { name: "totalUsers" }], dimensionFilter: seg, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 25 });
  const trendReq = runReport({ dateRanges, dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }, { name: "screenPageViews" }], dimensionFilter: seg, orderBys: [{ dimension: { dimensionName: "date" } }], limit: 400 });

  // ── Marketplace ────────────────────────────────────────────────────────────
  if (tranche === "marketplace") {
    const pagesReq = runReport({ dateRanges, dimensions: [{ name: "pagePath" }], metrics: [{ name: "screenPageViews" }, { name: "sessions" }, { name: "totalUsers" }], dimensionFilter: beginsWith("pagePath", MKT_PREFIX), orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: 300 });
    const eventsReq = runReport({ dateRanges, dimensions: [{ name: "pagePath" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: and(beginsWith("pagePath", MKT_PREFIX), inList("eventName", ["form_start", "click", "marketplace_inquiry"])), limit: 1000 });
    // Submitted inquiries per domain — needs the `domain_of_interest` event-scoped
    // custom dimension. safeRows → [] until it's registered in GA4, so the column
    // lights up automatically ~24-48h after setup with no code change.
    const submittedReq = safeRows({ dateRanges, dimensions: [{ name: "customEvent:domain_of_interest" }], metrics: [{ name: "eventCount" }], dimensionFilter: inList("eventName", ["generate_lead", "marketplace_inquiry"]), limit: 500 });
    const [summary, submit, channels, trend, pages, events, submittedRows, inventory] =
      await Promise.all([summaryReq, submitReq, channelReq, trendReq, pagesReq, eventsReq, submittedReq, marketplaceInventory()]);

    const bySlug = new Map<string, ListingRow>();
    const ensure = (slug: string): ListingRow => {
      let row = bySlug.get(slug);
      if (!row) { row = { domain: slugToDomain(slug), path: MKT_PREFIX + slug, views: 0, sessions: 0, users: 0, inquiryStarts: 0, clicks: 0, inquiries: 0 }; bySlug.set(slug, row); }
      return row;
    };
    for (const s of inventory) ensure(s);                                          // zero-traffic listings still appear
    for (const r of rowsOf(pages)) {
      const slug = slugOf(r.dimensionValues?.[0]?.value || ""); if (!slug) continue;
      const row = ensure(slug);
      row.views += n(r.metricValues?.[0]?.value); row.sessions += n(r.metricValues?.[1]?.value); row.users += n(r.metricValues?.[2]?.value);
    }
    for (const r of rowsOf(events)) {
      const slug = slugOf(r.dimensionValues?.[0]?.value || ""); if (!slug) continue;
      const ev = r.dimensionValues?.[1]?.value || ""; const c = n(r.metricValues?.[0]?.value);
      const row = ensure(slug);
      if (ev === "form_start") row.inquiryStarts += c;
      else if (ev === "click") row.clicks += c;
      else if (ev === "marketplace_inquiry") row.inquiries += c;
    }
    // Once the custom dimension is live, it's the authoritative per-domain submitted
    // count → override the interim per-page marketplace_inquiry (no double-count).
    const submittedByDomain = new Map<string, number>();
    for (const r of submittedRows) {
      const d = (r.dimensionValues?.[0]?.value || "").toLowerCase().replace(/^www\./, "").trim();
      if (d && d !== "(not set)") submittedByDomain.set(d, (submittedByDomain.get(d) || 0) + n(r.metricValues?.[0]?.value));
    }
    const customDimLive = submittedByDomain.size > 0;
    const listings = [...bySlug.values()]
      .map((row) => (customDimLive ? { ...row, inquiries: submittedByDomain.get(row.domain.toLowerCase()) || 0 } : row))
      .sort((a, b) => b.views - a.views || b.inquiryStarts - a.inquiryStarts);

    return {
      tranche: "marketplace",
      summary: { sessions: firstMetric(summary, 0), users: firstMetric(summary, 1), pageviews: firstMetric(summary, 2), submissions: firstMetric(submit, 0) + historicalCount("marketplace", from, to) },
      topPages: rowsOf(pages).map((r) => ({ path: r.dimensionValues?.[0]?.value || "", views: n(r.metricValues?.[0]?.value), users: n(r.metricValues?.[2]?.value) })),
      listings,
      channels: channelRows(channels),
      trend: trendRows(trend),
    };
  }

  // ── Blog / SEO ──────────────────────────────────────────────────────────────
  if (tranche === "blog") {
    const topPostsReq = runReport({ dateRanges, dimensions: [{ name: "pagePath" }], metrics: [{ name: "screenPageViews" }, { name: "totalUsers" }], dimensionFilter: blogPagePath(), orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: 100 });
    const sourcesReq = runReport({ dateRanges, dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }], metrics: [{ name: "sessions" }], dimensionFilter: seg, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 30 });
    const [summary, submit, channels, trend, topPosts, sources, funnel] = await Promise.all([summaryReq, submitReq, channelReq, trendReq, topPostsReq, sourcesReq, blogToSiteFunnel(from, to)]);
    return {
      tranche: "blog",
      summary: { sessions: firstMetric(summary, 0), users: firstMetric(summary, 1), pageviews: firstMetric(summary, 2), submissions: firstMetric(submit, 0) },
      topPosts: rowsOf(topPosts).map((r) => ({ path: r.dimensionValues?.[0]?.value || "", views: n(r.metricValues?.[0]?.value), users: n(r.metricValues?.[1]?.value) })),
      channels: channelRows(channels),
      sources: sourceRows(sources),
      funnel,
      trend: trendRows(trend),
    };
  }

  // ── Core / services ──────────────────────────────────────────────────────────
  const sourcesReq = runReport({ dateRanges, dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }], metrics: [{ name: "sessions" }], dimensionFilter: seg, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 30 });
  const submitByChannelReq = runReport({ dateRanges, dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "eventCount" }], dimensionFilter: and(seg, exact("eventName", "generate_lead")), orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 25 });
  // GA event-param breakdowns (need custom dimensions; safeRows → [] until then).
  const paramBreakdown = (param: string) => safeRows({ dateRanges, dimensions: [{ name: `customEvent:${param}` }], metrics: [{ name: "eventCount" }], dimensionFilter: exact("eventName", "generate_lead"), orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 25 });
  const [summary, submit, channels, trend, sources, submitByChannel, heard, intent, budget] = await Promise.all([
    summaryReq, submitReq, channelReq, trendReq, sourcesReq, submitByChannelReq,
    paramBreakdown("heard_about"), paramBreakdown("lead_intent"), paramBreakdown("lead_budget"),
  ]);
  // Blend GA (forward) with the bundled historical Formspark export (pre-cutoff).
  return {
    tranche: "core",
    summary: { sessions: firstMetric(summary, 0), users: firstMetric(summary, 1), pageviews: firstMetric(summary, 2), submissions: firstMetric(submit, 0) + historicalCount("core", from, to) },
    channels: channelRows(channels),
    sources: sourceRows(sources),
    submissionsByChannel: rowsOf(submitByChannel).map((r) => ({ label: r.dimensionValues?.[0]?.value || "(none)", value: n(r.metricValues?.[0]?.value) })),
    selfReportedSource: mergeLabelValues(toLV(heard), historicalBreakdown("source", from, to)),
    leadIntent: mergeLabelValues(toLV(intent), historicalBreakdown("intent", from, to)),
    leadBudget: mergeLabelValues(toLV(budget), historicalBreakdown("budget", from, to)),
    trend: trendRows(trend),
  };
}
