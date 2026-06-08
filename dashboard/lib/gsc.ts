// Google Search Console (Search Analytics) — server-only. Same service account as
// GA/Sheets, added as a user on the snagged.com property; the Search Console API
// must be enabled on the SA's GCP project. Answers "what do people search to find
// us, what ranks, and is the blog pulling search traffic."
//
// Note: GSC data lags ~2 days, so the most recent day or two of a window may be
// empty — that's expected, not an error. Property via GSC_SITE_URL (URL-prefix).

import { googleAccessToken } from "./google-auth";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const SITE = process.env.GSC_SITE_URL || "https://www.snagged.com/";

export function gscConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SA_KEY || process.env.GOOGLE_SA_KEY_B64);
}

type GscRow = { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number };
async function query(body: Record<string, unknown>): Promise<GscRow[]> {
  const token = await googleAccessToken(SCOPE);
  const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GSC ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { rows?: GscRow[] }).rows || [];
}

const blogFilter = { dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "contains", expression: "/post/" }] }] };
const num = (v?: number) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export type SeoRow = { key: string; clicks: number; impressions: number; ctr: number; position: number };
export type SeoTrend = { date: string; clicks: number; impressions: number };
export type SeoReport = {
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  topQueries: SeoRow[];
  topPages: SeoRow[];
  blogQueries: SeoRow[];
  blogPages: SeoRow[];
  trend: SeoTrend[];
};

const toSeo = (rows: GscRow[]): SeoRow[] => rows.map((r) => ({
  key: r.keys?.[0] || "", clicks: num(r.clicks), impressions: num(r.impressions), ctr: num(r.ctr), position: num(r.position),
}));

export async function seoReport(from: string, to: string): Promise<SeoReport> {
  const base = { startDate: from, endDate: to };
  const [totals, q, p, bq, bp, tr] = await Promise.all([
    query({ ...base, dimensions: [] }),
    query({ ...base, dimensions: ["query"], rowLimit: 25 }),
    query({ ...base, dimensions: ["page"], rowLimit: 25 }),
    query({ ...base, dimensions: ["query"], rowLimit: 25, ...blogFilter }),
    query({ ...base, dimensions: ["page"], rowLimit: 25, ...blogFilter }),
    query({ ...base, dimensions: ["date"], rowLimit: 1000 }),
  ]);
  const t = totals[0] || {};
  return {
    totals: { clicks: num(t.clicks), impressions: num(t.impressions), ctr: num(t.ctr), position: num(t.position) },
    topQueries: toSeo(q),
    topPages: toSeo(p),
    blogQueries: toSeo(bq),
    blogPages: toSeo(bp),
    trend: tr.map((r) => ({ date: r.keys?.[0] || "", clicks: num(r.clicks), impressions: num(r.impressions) })),
  };
}
