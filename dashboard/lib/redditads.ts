// Reddit Ads API v3 — ad-spend analytics for the Site Analytics "Ads" tranche, the
// Reddit counterpart to lib/xads.ts. Same report shape (AdReport) so the UI renders
// either platform identically; the ROI headline pairs Reddit spend with Reddit-attributed
// leads from core GA ("How did you hear about Snagged? → Reddit").
//
// Auth is OAuth2 Bearer (Reddit, unlike X, is OAuth2 not OAuth 1.0a). A Reddit **business**
// account + an approved dev app are required (https://ads-api.reddit.com/docs/v3/guides/
// quick-start/create-dev-app). We hold a long-lived refresh token and exchange it for a
// short-lived access token per run. Env (also in Vercel):
//   REDDIT_ADS_CLIENT_ID / REDDIT_ADS_CLIENT_SECRET  — the dev app's credentials
//   REDDIT_ADS_REFRESH_TOKEN                          — OAuth2 refresh token (adsread scope)
//   REDDIT_ADS_ACCOUNT_ID                             — the ad account (a2_… id)
//
// ⚠️ Endpoints/field-names are best-effort from the public v3 docs and NOT live-verified
// (creds are account-gated). The report parser is defensive (accepts spend as micros or a
// plain number, tolerant field names) so first-run drift is easy to correct. Base:
//   token  POST https://www.reddit.com/api/v1/access_token
//   api        https://ads-api.reddit.com/api/v3
//   report POST /ad_accounts/{account_id}/reports

import { analyticsReport, gaConfigured } from "./ga";
import type { AdReport, AdTotals, AdCampaign, AdDaily, AdRoi } from "./ads-types";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API = "https://ads-api.reddit.com/api/v3";
const TZ = "America/New_York";

export function redditAdsConfigured(): boolean {
  return Boolean(
    process.env.REDDIT_ADS_CLIENT_ID &&
      process.env.REDDIT_ADS_CLIENT_SECRET &&
      process.env.REDDIT_ADS_REFRESH_TOKEN &&
      process.env.REDDIT_ADS_ACCOUNT_ID,
  );
}

// Exchange the refresh token for a short-lived bearer (cached in-module for the request).
let tokenCache: { token: string; exp: number } | null = null;
async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 30_000) return tokenCache.token;
  const id = process.env.REDDIT_ADS_CLIENT_ID!;
  const secret = process.env.REDDIT_ADS_CLIENT_SECRET!;
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: process.env.REDDIT_ADS_REFRESH_TOKEN! });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "snagged-admin/1.0" },
    body,
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) throw new Error(`Reddit auth ${res.status}: ${data.error || "no token"}`);
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "snagged-admin/1.0" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(`Reddit Ads ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return json as T;
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Reddit reports spend in microcurrency on some endpoints; if the value looks like micros
// (>= 1e6 for a plausibly-small campaign) we can't be sure, so we normalize by the field
// name instead: *_micros → /1e6, else as-is. Defensive until live-verified.
function spendOf(row: Record<string, unknown>): number {
  if (row.spend_micros != null) return num(row.spend_micros) / 1e6;
  if (row.spend != null) return num(row.spend);
  if (row.cost != null) return num(row.cost);
  return 0;
}
function pick(row: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) if (row[k] != null) return num(row[k]);
  return 0;
}

// Reddit-attributed leads from the core funnel's self-reported source.
function redditLeads(rows: { label: string; value: number }[]): number {
  return rows.filter((r) => /reddit/i.test(r.label)).reduce((a, r) => a + r.value, 0);
}

function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`); const end = new Date(`${to}T00:00:00Z`);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

// Pull a per-day, per-campaign spend report over [from, to]. Best-effort request body
// against the v3 reports endpoint; parsing is tolerant of the exact metric/breakdown shape.
export async function redditAdsReport(from: string, to: string): Promise<AdReport> {
  const accountId = process.env.REDDIT_ADS_ACCOUNT_ID!;
  const reqBody = {
    data: {
      starts_at: `${from}T00:00:00Z`,
      ends_at: `${to}T23:59:59Z`,
      time_zone_id: TZ,
      breakdowns: ["DATE"],
      group_by: ["CAMPAIGN_ID"],
      fields: ["spend", "impressions", "clicks", "campaign_id", "campaign_name", "date"],
    },
  };
  let rows: Record<string, unknown>[] = [];
  try {
    const r = await api<{ data?: { metrics?: Record<string, unknown>[]; rows?: Record<string, unknown>[] } | Record<string, unknown>[] }>(
      "POST", `/ad_accounts/${accountId}/reports`, reqBody,
    );
    const d = r.data as { metrics?: Record<string, unknown>[]; rows?: Record<string, unknown>[] } | Record<string, unknown>[] | undefined;
    rows = Array.isArray(d) ? d : (d?.metrics || d?.rows || []);
  } catch {
    rows = []; // fail-open — the tab still renders zeros + the not-yet-verified note
  }

  const dates = dateRange(from, to);
  type Agg = { spend: number; impressions: number; clicks: number };
  const blank = (): Agg => ({ spend: 0, impressions: 0, clicks: 0 });
  const byCampaign = new Map<string, Agg>();
  const byDate = new Map<string, Agg>();
  for (const dt of dates) byDate.set(dt, blank());
  const nameById = new Map<string, string>();

  for (const row of rows) {
    const cid = String(row.campaign_id ?? row.campaignId ?? row.id ?? "reddit");
    const date = String(row.date ?? row.day ?? "").slice(0, 10);
    nameById.set(cid, String(row.campaign_name ?? row.campaignName ?? row.name ?? cid));
    const s = spendOf(row), im = pick(row, "impressions"), cl = pick(row, "clicks");
    const c = byCampaign.get(cid) || blank(); c.spend += s; c.impressions += im; c.clicks += cl; byCampaign.set(cid, c);
    if (byDate.has(date)) { const d2 = byDate.get(date)!; d2.spend += s; d2.impressions += im; d2.clicks += cl; }
  }

  let spend = 0, impressions = 0, clicks = 0;
  for (const a of byCampaign.values()) { spend += a.spend; impressions += a.impressions; clicks += a.clicks; }
  const totals: AdTotals = {
    spend, impressions, clicks, engagements: 0,
    cpc: clicks ? spend / clicks : 0,
    cpm: impressions ? (spend / impressions) * 1000 : 0,
    ctr: impressions ? clicks / impressions : 0,
  };
  const byCampaignRows: AdCampaign[] = [...byCampaign.entries()]
    .map(([id, a]) => ({ id, name: nameById.get(id) || id, status: "", spend: a.spend, impressions: a.impressions, clicks: a.clicks, engagements: 0, cpc: a.clicks ? a.spend / a.clicks : 0 }))
    .filter((c) => c.spend > 0 || c.impressions > 0)
    .sort((a, b) => b.spend - a.spend);
  const trend: AdDaily[] = dates.map((date) => { const a = byDate.get(date)!; return { date, spend: a.spend, impressions: a.impressions, clicks: a.clicks }; });

  // ── ROI — Reddit spend vs Reddit-attributed leads ─────────────────────────────
  const roi: AdRoi = { leads: null, totalLeads: null, costPerLead: null, gaConfigured: gaConfigured() };
  if (gaConfigured()) {
    try {
      const core = await analyticsReport("core", from, to);
      if (core.tranche === "core") {
        const leads = redditLeads(core.selfReportedSource);
        roi.leads = leads;
        roi.totalLeads = core.selfReportedSource.reduce((a, r) => a + r.value, 0);
        roi.costPerLead = leads > 0 ? spend / leads : null;
      }
    } catch { /* leave leads null — spend still renders */ }
  }
  return { totals, byCampaign: byCampaignRows, trend, roi, campaignCount: byCampaignRows.length };
}
