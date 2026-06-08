// Google Analytics 4 (Data API) client — server-only.
//
// Auth: a Google service account (the same `marketplace-pipeline` SA that reads
// our Sheets) granted Viewer on the GA4 property. We mint a signed JWT and
// exchange it for an access token — no user OAuth, no google-auth-library
// dependency (Node's built-in `crypto` signs RS256). Token is cached at module
// scope until ~1 min before expiry.
//
// Env (set in the snagged-admin Vercel project — NOT just the sandbox):
//   GA4_PROPERTY_ID   e.g. "420532804" (bare number; we prefix "properties/")
//   GOOGLE_SA_KEY     full service-account JSON (one line), OR
//   GOOGLE_SA_KEY_B64 base64 of that JSON (preferred — survives any env UI)
//
// Exposes the low-level `runReport` plus `analyticsReport(tranche, from, to)`,
// which runs the handful of segmented queries the Site Analytics page needs and
// returns a tidy, typed structure. The two tranches:
//   • marketplace = sessions/pages under /domains/*  (the type-in domain buyers)
//   • core        = everything else (the services / sell-side site)

import crypto from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const MKT_PREFIX = "/domains/"; // the marketplace landing/path namespace

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

function serviceAccount(): ServiceAccount {
  const raw =
    process.env.GOOGLE_SA_KEY ||
    (process.env.GOOGLE_SA_KEY_B64
      ? Buffer.from(process.env.GOOGLE_SA_KEY_B64, "base64").toString("utf8")
      : "");
  if (!raw) throw new Error("GOOGLE_SA_KEY (or GOOGLE_SA_KEY_B64) is not set");
  const sa = JSON.parse(raw) as ServiceAccount;
  if (!sa.client_email || !sa.private_key) throw new Error("service-account JSON missing client_email / private_key");
  return sa;
}

function propertyPath(): string {
  const p = (process.env.GA4_PROPERTY_ID || "").trim();
  if (!p) throw new Error("GA4_PROPERTY_ID is not set");
  return p.startsWith("properties/") ? p : `properties/${p}`;
}

// True when the deployment has the config needed to talk to GA — so the page/API
// can render a friendly "not configured" state instead of throwing.
export function gaConfigured(): boolean {
  return Boolean(
    (process.env.GOOGLE_SA_KEY || process.env.GOOGLE_SA_KEY_B64) && process.env.GA4_PROPERTY_ID,
  );
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let cachedToken: { value: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;
  const sa = serviceAccount();
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
  const signingInput = `${header}.${claims}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const assertion = `${signingInput}.${b64url(signer.sign(sa.private_key))}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`GA token exchange failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { access_token: string; expires_in?: number };
  cachedToken = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

// ── Low-level runReport ─────────────────────────────────────────────────────
type GaRow = { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] };
type GaReport = { rows?: GaRow[]; rowCount?: number };

export async function runReport(body: Record<string, unknown>): Promise<GaReport> {
  const token = await accessToken();
  const res = await fetch(`${DATA_API}/${propertyPath()}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GA runReport ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as GaReport;
}

// ── Filter helpers (mirror the probe that validated the segmentation) ────────
const beginsWith = (fieldName: string, value: string) => ({ filter: { fieldName, stringFilter: { matchType: "BEGINS_WITH", value } } });
const exact = (fieldName: string, value: string) => ({ filter: { fieldName, stringFilter: { value } } });
const not = (e: unknown) => ({ notExpression: e });
const and = (...exprs: unknown[]) => ({ andGroup: { expressions: exprs } });

// A session-scoped marketplace/core split by where the session LANDED.
const landingSegment = (isMkt: boolean) => {
  const f = beginsWith("landingPagePlusQueryString", MKT_PREFIX);
  return isMkt ? f : not(f);
};

const n = (v?: string) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const rowsOf = (r: GaReport) => r.rows || [];
// First metric of a single-row, dimensionless report (e.g. a summed total).
const firstMetric = (r: GaReport, i = 0) => n(rowsOf(r)[0]?.metricValues?.[i]?.value);
const ymd = (raw: string) => (/^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw);

// ── Typed report shapes the client renders ──────────────────────────────────
export type StatBlock = { sessions: number; users: number; pageviews: number; submissions: number };
export type ChannelRow = { channel: string; sessions: number; users: number };
export type PageRow = { path: string; views: number; users: number };
export type SourceRow = { source: string; medium: string; sessions: number };
export type LabelValue = { label: string; value: number };
export type TrendRow = { date: string; sessions: number; pageviews: number };

export type MarketplaceReport = {
  tranche: "marketplace";
  summary: StatBlock;
  topPages: PageRow[];
  channels: ChannelRow[];
  trend: TrendRow[];
};
export type CoreReport = {
  tranche: "core";
  summary: StatBlock;
  channels: ChannelRow[];
  sources: SourceRow[];
  submissionsByChannel: LabelValue[];
  trend: TrendRow[];
};
export type AnalyticsReport = MarketplaceReport | CoreReport;

export type Tranche = "marketplace" | "core";

// The GA4 conversion event our Webflow snippet fires per flow.
const SUBMIT_EVENT: Record<Tranche, string> = { marketplace: "marketplace_inquiry", core: "generate_lead" };

// Run all queries for one tranche over an ET day range [from, to] (YYYY-MM-DD;
// GA interprets these in the property's timezone, which is America/New_York).
export async function analyticsReport(tranche: Tranche, from: string, to: string): Promise<AnalyticsReport> {
  const dateRanges = [{ startDate: from, endDate: to }];
  const isMkt = tranche === "marketplace";
  const seg = landingSegment(isMkt);

  // Summary (session-scoped totals) + the form-submission event count for the flow.
  const summaryReq = runReport({
    dateRanges,
    metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }],
    dimensionFilter: seg,
  });
  const submitReq = runReport({
    dateRanges,
    dimensions: [{ name: "eventName" }],
    metrics: [{ name: "eventCount" }],
    dimensionFilter: and(seg, exact("eventName", SUBMIT_EVENT[tranche])),
  });
  // Traffic by channel (both tranches).
  const channelReq = runReport({
    dateRanges,
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }, { name: "totalUsers" }],
    dimensionFilter: seg,
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 25,
  });
  // Daily trend (both tranches).
  const trendReq = runReport({
    dateRanges,
    dimensions: [{ name: "date" }],
    metrics: [{ name: "sessions" }, { name: "screenPageViews" }],
    dimensionFilter: seg,
    orderBys: [{ dimension: { dimensionName: "date" } }],
    limit: 400,
  });

  if (isMkt) {
    // Per-page views — the "how many views each domain page gets". Page-scoped,
    // so filter on pagePath (not the session landing page).
    const topPagesReq = runReport({
      dateRanges,
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }, { name: "totalUsers" }],
      dimensionFilter: beginsWith("pagePath", MKT_PREFIX),
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 100,
    });
    const [summary, submit, channels, trend, topPages] = await Promise.all([
      summaryReq, submitReq, channelReq, trendReq, topPagesReq,
    ]);
    return {
      tranche: "marketplace",
      summary: {
        sessions: firstMetric(summary, 0),
        users: firstMetric(summary, 1),
        pageviews: firstMetric(summary, 2),
        submissions: firstMetric(submit, 0),
      },
      topPages: rowsOf(topPages).map((r) => ({
        path: r.dimensionValues?.[0]?.value || "",
        views: n(r.metricValues?.[0]?.value),
        users: n(r.metricValues?.[1]?.value),
      })),
      channels: rowsOf(channels).map((r) => ({
        channel: r.dimensionValues?.[0]?.value || "(none)",
        sessions: n(r.metricValues?.[0]?.value),
        users: n(r.metricValues?.[1]?.value),
      })),
      trend: rowsOf(trend).map((r) => ({
        date: ymd(r.dimensionValues?.[0]?.value || ""),
        sessions: n(r.metricValues?.[0]?.value),
        pageviews: n(r.metricValues?.[1]?.value),
      })),
    };
  }

  // Core: where traffic comes from (source/medium) + form submissions by channel.
  const sourcesReq = runReport({
    dateRanges,
    dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: seg,
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 30,
  });
  const submitByChannelReq = runReport({
    dateRanges,
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "eventCount" }],
    dimensionFilter: and(seg, exact("eventName", SUBMIT_EVENT.core)),
    orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
    limit: 25,
  });
  const [summary, submit, channels, trend, sources, submitByChannel] = await Promise.all([
    summaryReq, submitReq, channelReq, trendReq, sourcesReq, submitByChannelReq,
  ]);
  return {
    tranche: "core",
    summary: {
      sessions: firstMetric(summary, 0),
      users: firstMetric(summary, 1),
      pageviews: firstMetric(summary, 2),
      submissions: firstMetric(submit, 0),
    },
    channels: rowsOf(channels).map((r) => ({
      channel: r.dimensionValues?.[0]?.value || "(none)",
      sessions: n(r.metricValues?.[0]?.value),
      users: n(r.metricValues?.[1]?.value),
    })),
    sources: rowsOf(sources).map((r) => ({
      source: r.dimensionValues?.[0]?.value || "(none)",
      medium: r.dimensionValues?.[1]?.value || "(none)",
      sessions: n(r.metricValues?.[0]?.value),
    })),
    submissionsByChannel: rowsOf(submitByChannel).map((r) => ({
      label: r.dimensionValues?.[0]?.value || "(none)",
      value: n(r.metricValues?.[0]?.value),
    })),
    trend: rowsOf(trend).map((r) => ({
      date: ymd(r.dimensionValues?.[0]?.value || ""),
      sessions: n(r.metricValues?.[0]?.value),
      pageviews: n(r.metricValues?.[1]?.value),
    })),
  };
}
