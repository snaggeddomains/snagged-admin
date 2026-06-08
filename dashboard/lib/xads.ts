// X (Twitter) Ads API — ad-spend analytics for the Site Analytics report. X is
// Snagged's #1 self-reported lead source, so this tranche pairs spend/engagement
// from the Ads API with the X-attributed lead count from core GA to give a real
// cost-per-lead (ROI) headline.
//
// Auth is OAuth 1.0a request signing (HMAC-SHA1), hand-rolled with Node's crypto
// so we don't add a dependency — same dependency-free spirit as lib/google-auth.ts
// (which signs RS256 JWTs). Env (also in Vercel):
//   X_ADS_CONSUMER_KEY / X_ADS_CONSUMER_SECRET   — the app's API key/secret
//   X_ADS_ACCESS_TOKEN / X_ADS_ACCESS_TOKEN_SECRET — the account access token
//   X_ADS_ACCOUNT_ID                              — the ads account (e.g. 18ce55lp5d7)
//
// API notes confirmed by live probe (2026-06-08, app 33036944, Standard access):
//   • Base https://ads-api.x.com/12 (v12 authenticates fine).
//   • Spend = billed_charge_local_micro / 1_000_000 (micros; account currency USD).
//   • Stats come back as per-day arrays under data[].id_data[].metrics, or null
//     when an entity had no activity in the window.
//   • DAY granularity is capped at a 7-day (+1h) window per call, and ≤20 entity
//     ids per call — so we chunk both the date range and the campaign list.
//   • Day boundaries must be midnight in the ACCOUNT's timezone (America/New_York),
//     not UTC — tzMidnightUtc() computes that instant.

import crypto from "node:crypto";
import { analyticsReport, gaConfigured, dailyChannelSessions } from "./ga";
import {
  readDailyRows, upsertDailyRows, xAdsStoreConfigured, type XAdsDailyRow,
  readAdDailyRows, upsertAdDailyRows, type XAdsAdDailyRow,
} from "./xads-store";

const API = "https://ads-api.x.com/12";
const TZ = "America/New_York"; // the ads account's timezone (from the account probe)

export function xAdsConfigured(): boolean {
  return Boolean(
    process.env.X_ADS_CONSUMER_KEY &&
      process.env.X_ADS_CONSUMER_SECRET &&
      process.env.X_ADS_ACCESS_TOKEN &&
      process.env.X_ADS_ACCESS_TOKEN_SECRET &&
      process.env.X_ADS_ACCOUNT_ID,
  );
}

// ── OAuth 1.0a signing ───────────────────────────────────────────────────────
// RFC 3986 percent-encoding (stricter than encodeURIComponent — also escapes !*'()).
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function authHeader(method: string, url: string): string {
  const u = new URL(url);
  const ck = process.env.X_ADS_CONSUMER_KEY!;
  const cs = process.env.X_ADS_CONSUMER_SECRET!;
  const at = process.env.X_ADS_ACCESS_TOKEN!;
  const ats = process.env.X_ADS_ACCESS_TOKEN_SECRET!;
  const oauth: Record<string, string> = {
    oauth_consumer_key: ck,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: at,
    oauth_version: "1.0",
  };
  // Signature base string folds the oauth params together with the query params.
  const all: Record<string, string> = { ...oauth };
  for (const [k, v] of u.searchParams) all[k] = v;
  const paramStr = Object.keys(all)
    .map((k) => [enc(k), enc(all[k])] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(paramStr)].join("&");
  const signingKey = `${enc(cs)}&${enc(ats)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${enc(k)}="${enc(oauth[k])}"`)
      .join(", ")
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The Ads API rate-limits per access token over a rolling window; a wide date
// range fans out enough stats calls to trip a 429 if we burst them. apiGet retries
// 429s (and transient 5xx) with backoff, honoring the reset/Retry-After header when
// present, and the stats fan-out is run through a small concurrency pool (mapPool).
async function apiGet<T>(path: string, query: Record<string, string> = {}, attempt = 0): Promise<T> {
  const qs = new URLSearchParams(query).toString();
  const url = `${API}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { Authorization: authHeader("GET", url) } });
  if (res.ok) return (await res.json()) as T;
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    // Prefer the API's own hint: rate-limit reset (epoch secs) or Retry-After (secs).
    const reset = Number(res.headers.get("x-rate-limit-reset") || res.headers.get("x-account-rate-limit-reset"));
    const retryAfter = Number(res.headers.get("retry-after"));
    let waitMs = 0;
    if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = retryAfter * 1000;
    else if (Number.isFinite(reset) && reset > 0) waitMs = Math.max(0, reset * 1000 - Date.now());
    if (!waitMs || res.status >= 500) waitMs = Math.min(15000, 500 * 2 ** attempt); // exp backoff, capped
    waitMs = Math.min(waitMs, 20000) + Math.floor(Math.random() * 250); // cap + jitter
    await sleep(waitMs);
    return apiGet<T>(path, query, attempt + 1);
  }
  throw new Error(`X Ads ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// Run async tasks with a bounded concurrency so we don't burst the rate limit.
async function mapPool<T>(tasks: (() => Promise<T>)[], concurrency = 4): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Date helpers (account-timezone day math) ─────────────────────────────────
// The ET UTC-offset (ms) at midnight of a given date — i.e. (ET wall time − UTC).
// -04:00 during EDT, -05:00 during EST.
function etOffsetMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcGuess));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return asUtc - utcGuess;
}

// Midnight of an ET date, as a UTC instant ISO string — the boundary the stats
// endpoint requires for DAY granularity.
function tzMidnightUtc(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  return new Date(utcGuess - etOffsetMs(ymd)).toISOString().replace(/\.\d+Z$/, "Z");
}

const addDays = (ymd: string, n: number): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// Inclusive list of YYYY-MM-DD dates for [from, to] (cap generous enough for a
// multi-year backfill).
function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > 2000) break; // safety
  }
  return out;
}

// Group dates into ≤maxLen-day chunks that NEVER straddle a DST transition. The
// stats endpoint rejects a DAY-granularity window whose start_time and end_time
// land on different UTC offsets (e.g. a week across the Nov fall-back: start −04:00,
// end −05:00) — it surfaces as a misleading INVALID_PARAMETER "entity" 400. We keep
// extending a chunk only while both the next day AND its end-boundary share the
// start day's offset; a transition day falls out as its own (unavoidably straddling)
// 1-day chunk, which the fault-tolerant fetch can drop without losing a whole week.
function dstSafeChunks(dates: string[], maxLen = 7): string[][] {
  const out: string[][] = [];
  let i = 0;
  while (i < dates.length) {
    const startOffset = etOffsetMs(dates[i]);
    const group = [dates[i]];
    let j = i;
    while (group.length < maxLen && j + 1 < dates.length) {
      const cand = dates[j + 1];
      if (etOffsetMs(cand) === startOffset && etOffsetMs(addDays(cand, 1)) === startOffset) {
        group.push(cand);
        j++;
      } else break;
    }
    out.push(group);
    i = j + 1;
  }
  return out;
}

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// ── API shapes ───────────────────────────────────────────────────────────────
type Campaign = { id: string; name: string; entity_status?: string; effective_status?: string };
type StatMetrics = {
  impressions?: (number | null)[] | null;
  clicks?: (number | null)[] | null;
  engagements?: (number | null)[] | null;
  billed_charge_local_micro?: (number | null)[] | null;
};
type StatEntity = { id: string; id_data: { segment: unknown; metrics: StatMetrics }[] };
type StatsResp = { time_series_length: number; data: StatEntity[] };

// ── Public report shape (mirrors the other tranches) ─────────────────────────
export type XAdsCampaign = {
  id: string;
  name: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  engagements: number;
  cpc: number;
};
export type XAdsDaily = { date: string; spend: number; impressions: number; clicks: number };
export type XAdsTotals = {
  spend: number;
  impressions: number;
  clicks: number;
  engagements: number;
  cpc: number; // spend / clicks
  cpm: number; // spend / impressions * 1000
  ctr: number; // clicks / impressions
};
// ROI = X spend measured against the X-attributed leads the core funnel reports
// (the "How did you hear about us → X / Twitter" self-report, which already blends
// the historical Formspark export with live GA). leads/costPerLead are null when
// GA isn't configured for the deployment.
export type XAdsRoi = {
  leads: number | null; // X-attributed leads in the window
  totalLeads: number | null; // all self-reported leads (for share context)
  costPerLead: number | null; // spend / X-attributed leads
  gaConfigured: boolean;
};
export type XAdsReport = {
  totals: XAdsTotals;
  byCampaign: XAdsCampaign[];
  trend: XAdsDaily[];
  roi: XAdsRoi;
  campaignCount: number;
};

async function fetchCampaigns(accountId: string): Promise<Campaign[]> {
  const out: Campaign[] = [];
  let cursor: string | undefined;
  do {
    const q: Record<string, string> = { count: "1000" };
    if (cursor) q.cursor = cursor;
    const r = await apiGet<{ data?: Campaign[]; next_cursor?: string | null }>(
      `/accounts/${accountId}/campaigns`,
      q,
    );
    out.push(...(r.data || []));
    cursor = r.next_cursor || undefined;
  } while (cursor && out.length < 5000);
  return out;
}

const num = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Today's date in the account timezone (ET) — the upper bound for a live sync.
export function etToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

// Fetch per-campaign per-day rows live from the API over [from, to]. Chunks the
// range into ≤7-day sub-windows × ≤20-id campaign groups (the API's DAY-granularity
// + entity caps) and runs them through the concurrency pool. Emits one row per
// (campaign, day) with any activity; all-null/zero days are skipped (absent ⇒ 0).
async function fetchDailyRowsLive(from: string, to: string): Promise<XAdsDailyRow[]> {
  const accountId = process.env.X_ADS_ACCOUNT_ID!;
  const dates = dateRange(from, to);
  const campaigns = await fetchCampaigns(accountId);
  const meta = new Map(campaigns.map((c) => [c.id, { name: c.name, status: c.effective_status || c.entity_status || "" }]));
  const rows: XAdsDailyRow[] = [];
  const idChunks = chunk(campaigns.map((c) => c.id), 20);
  const tasks: (() => Promise<void>)[] = [];
  let failed = 0;
  for (const dc of dstSafeChunks(dates, 7)) {
    const start = tzMidnightUtc(dc[0]);
    const end = tzMidnightUtc(addDays(dc[dc.length - 1], 1)); // exclusive upper bound
    for (const ids of idChunks) {
      tasks.push(async () => {
        let resp: StatsResp;
        try {
          resp = await apiGet<StatsResp>(`/stats/accounts/${accountId}`, {
            entity: "CAMPAIGN", entity_ids: ids.join(","), metric_groups: "ENGAGEMENT,BILLING",
            granularity: "DAY", placement: "ALL_ON_TWITTER", start_time: start, end_time: end,
          });
        } catch (e) {
          // One bad slice (e.g. an unavoidable DST-transition day) must not abort the
          // whole sync — skip it and keep the rest. The next clean sync re-covers it.
          failed++;
          if (failed <= 5) console.warn(`x_ads: stats slice ${dc[0]}..${dc[dc.length - 1]} failed: ${String((e as Error)?.message || e).slice(0, 160)}`);
          return;
        }
        for (const ent of resp.data || []) {
          const m = ent.id_data?.[0]?.metrics;
          if (!m) continue;
          const info = meta.get(ent.id) || { name: ent.id, status: "" };
          for (let i = 0; i < dc.length; i++) {
            const spend = num(m.billed_charge_local_micro?.[i]) / 1_000_000;
            const impressions = num(m.impressions?.[i]);
            const clicks = num(m.clicks?.[i]);
            const engagements = num(m.engagements?.[i]);
            if (!spend && !impressions && !clicks && !engagements) continue;
            rows.push({ date: dc[i], campaignId: ent.id, name: info.name, status: info.status, spend, impressions, clicks, engagements });
          }
        }
      });
    }
  }
  await mapPool(tasks);
  if (failed) console.warn(`x_ads: ${failed}/${tasks.length} stats slices failed (skipped)`);
  return rows;
}

// The read path used by the report + lift: prefer the local cache (fast, consistent,
// no API load), fall back to a live fetch when the cache is unconfigured or empty
// (e.g. before the first sync / backfill).
async function getDailyRows(from: string, to: string): Promise<XAdsDailyRow[]> {
  if (xAdsStoreConfigured()) {
    const cached = await readDailyRows(from, to);
    if (cached.length) return cached;
  }
  return fetchDailyRowsLive(from, to);
}

// Cron entry point: pull the trailing `days` of daily rows live and upsert them into
// the cache. A short trailing window keeps each run cheap while correcting the recent
// days X is still revising; pass a large `days` once to backfill history.
export async function syncXAdsDaily(
  opts: { days?: number; from?: string; to?: string } = {},
): Promise<{ rows: number; from: string; to: string }> {
  const to = opts.to || etToday();
  const from = opts.from || addDays(to, -(Math.max(1, opts.days ?? 14) - 1));
  const rows = await fetchDailyRowsLive(from, to);
  const written = await upsertDailyRows(rows);
  return { rows: written, from, to };
}

// ── Per-ad (promoted tweet) sync ─────────────────────────────────────────────
type LineItem = { id: string; campaign_id?: string };
type PromotedTweet = { id: string; line_item_id?: string; tweet_id?: string; entity_status?: string };

async function fetchPaged<T>(accountId: string, path: string, extra: Record<string, string> = {}): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const q: Record<string, string> = { count: "1000", with_deleted: "true", ...extra };
    if (cursor) q.cursor = cursor;
    const r = await apiGet<{ data?: T[]; next_cursor?: string | null }>(`/accounts/${accountId}${path}`, q);
    out.push(...(r.data || []));
    cursor = r.next_cursor || undefined;
  } while (cursor && out.length < 20000);
  return out;
}

// Tweet text by tweet_id, for labeling each ad by its creative. Batched (≤200/call);
// best-effort — a failed batch just leaves those ads labeled by id.
async function fetchTweetTexts(accountId: string, tweetIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const batch of chunk([...new Set(tweetIds)], 150)) {
    try {
      const r = await apiGet<{ data?: { tweet_id?: string; id_str?: string; text?: string; full_text?: string }[] }>(
        `/accounts/${accountId}/tweets`,
        { tweet_ids: batch.join(","), tweet_type: "PUBLISHED", count: "200" },
      );
      for (const t of r.data || []) {
        const id = t.tweet_id || t.id_str || "";
        const text = (t.full_text || t.text || "").replace(/\s+/g, " ").trim();
        if (id) out.set(id, text);
      }
    } catch { /* labels fall back to id */ }
  }
  return out;
}

// Fetch per-ad per-day rows live over [from, to]: resolve campaign→line-item→promoted-
// tweet, label each by tweet text, then pull PROMOTED_TWEET stats (DST-safe chunks ×
// ≤20-id groups, fault-tolerant).
async function fetchAdDailyRowsLive(from: string, to: string): Promise<XAdsAdDailyRow[]> {
  const accountId = process.env.X_ADS_ACCOUNT_ID!;
  const dates = dateRange(from, to);
  const [campaigns, lineItems, promoted] = await Promise.all([
    fetchCampaigns(accountId),
    fetchPaged<LineItem>(accountId, "/line_items"),
    fetchPaged<PromotedTweet>(accountId, "/promoted_tweets"),
  ]);
  const campNameById = new Map(campaigns.map((c) => [c.id, c.name]));
  const campByLineItem = new Map(lineItems.map((li) => [li.id, li.campaign_id || ""]));
  const tweetText = await fetchTweetTexts(accountId, promoted.map((p) => p.tweet_id || "").filter(Boolean));
  // ad_id → { campaignId, campaignName, adName, tweetId, status }
  const adMeta = new Map<string, { campaignId: string; campaignName: string; adName: string; tweetId: string; status: string }>();
  for (const p of promoted) {
    const campaignId = campByLineItem.get(p.line_item_id || "") || "";
    const tweetId = p.tweet_id || "";
    const text = tweetText.get(tweetId) || "";
    adMeta.set(p.id, {
      campaignId,
      campaignName: campNameById.get(campaignId) || campaignId,
      adName: text ? (text.length > 90 ? text.slice(0, 90) + "…" : text) : `tweet ${tweetId || p.id}`,
      tweetId,
      status: p.entity_status || "",
    });
  }
  const adIds = [...adMeta.keys()];

  const rows: XAdsAdDailyRow[] = [];
  const tasks: (() => Promise<void>)[] = [];
  let failed = 0;
  for (const dc of dstSafeChunks(dates, 7)) {
    const start = tzMidnightUtc(dc[0]);
    const end = tzMidnightUtc(addDays(dc[dc.length - 1], 1));
    for (const ids of chunk(adIds, 20)) {
      tasks.push(async () => {
        let resp: StatsResp;
        try {
          resp = await apiGet<StatsResp>(`/stats/accounts/${accountId}`, {
            entity: "PROMOTED_TWEET", entity_ids: ids.join(","), metric_groups: "ENGAGEMENT,BILLING",
            granularity: "DAY", placement: "ALL_ON_TWITTER", start_time: start, end_time: end,
          });
        } catch (e) {
          failed++;
          if (failed <= 5) console.warn(`x_ads ads: slice ${dc[0]}..${dc[dc.length - 1]} failed: ${String((e as Error)?.message || e).slice(0, 160)}`);
          return;
        }
        for (const ent of resp.data || []) {
          const m = ent.id_data?.[0]?.metrics;
          if (!m) continue;
          const meta = adMeta.get(ent.id);
          if (!meta) continue;
          for (let i = 0; i < dc.length; i++) {
            const spend = num(m.billed_charge_local_micro?.[i]) / 1_000_000;
            const impressions = num(m.impressions?.[i]);
            const clicks = num(m.clicks?.[i]);
            const engagements = num(m.engagements?.[i]);
            if (!spend && !impressions && !clicks && !engagements) continue;
            rows.push({ date: dc[i], adId: ent.id, ...meta, spend, impressions, clicks, engagements });
          }
        }
      });
    }
  }
  await mapPool(tasks);
  if (failed) console.warn(`x_ads ads: ${failed}/${tasks.length} stats slices failed (skipped)`);
  return rows;
}

async function getAdDailyRows(from: string, to: string): Promise<XAdsAdDailyRow[]> {
  if (xAdsStoreConfigured()) {
    const cached = await readAdDailyRows(from, to);
    if (cached.length) return cached;
  }
  return fetchAdDailyRowsLive(from, to);
}

// Cron entry point for the per-ad cache (synced alongside the campaign cache).
export async function syncXAdsAdsDaily(
  opts: { days?: number; from?: string; to?: string } = {},
): Promise<{ rows: number; from: string; to: string }> {
  const to = opts.to || etToday();
  const from = opts.from || addDays(to, -(Math.max(1, opts.days ?? 14) - 1));
  const rows = await fetchAdDailyRowsLive(from, to);
  const written = await upsertAdDailyRows(rows);
  return { rows: written, from, to };
}

// ── Effectiveness (per-campaign + per-ad) ────────────────────────────────────
// Engagement efficiency + runtime + week-over-week trend, per campaign and per ad.
// (Conversion efficiency stays account-level via the lift model until the X pixel
// fires per-ad conversions.) Reads from the cache (live fallback) like everything else.
export type EffWeek = { week: string; ctr: number; spend: number; impressions: number };
export type EffRow = {
  id: string;
  name: string;
  campaign: string; // parent campaign (ads only; "" for campaigns)
  status: string;
  firstDay: string;
  lastDay: string;
  daysActive: number;
  spend: number;
  impressions: number;
  clicks: number;
  engagements: number;
  ctr: number; // clicks / impressions
  cpc: number; // spend / clicks
  cpm: number; // spend / 1k impressions
  cpe: number; // spend / engagement
  engRate: number; // engagements / impressions
  weekly: EffWeek[];
};
export type XAdsEffectiveness = { from: string; to: string; campaigns: EffRow[]; ads: EffRow[] };

// Monday-anchored ISO week key for the day-of-week-stable weekly trend.
function weekKey(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

type EffInput = { id: string; name: string; campaign: string; status: string; date: string; spend: number; impressions: number; clicks: number; engagements: number };
function buildEff(items: EffInput[]): EffRow[] {
  const byId = new Map<string, EffInput[]>();
  for (const it of items) {
    const arr = byId.get(it.id);
    if (arr) arr.push(it); else byId.set(it.id, [it]);
  }
  const out: EffRow[] = [];
  for (const [id, arr] of byId) {
    let spend = 0, impressions = 0, clicks = 0, engagements = 0;
    let name = id, campaign = "", status = "";
    const activeDays = new Set<string>();
    const wk = new Map<string, { spend: number; impr: number; clicks: number }>();
    for (const it of arr) {
      spend += it.spend; impressions += it.impressions; clicks += it.clicks; engagements += it.engagements;
      if (it.spend || it.impressions || it.clicks || it.engagements) activeDays.add(it.date);
      if (it.name) name = it.name;
      if (it.campaign) campaign = it.campaign;
      if (it.status) status = it.status;
      const k = weekKey(it.date);
      const w = wk.get(k) || { spend: 0, impr: 0, clicks: 0 };
      w.spend += it.spend; w.impr += it.impressions; w.clicks += it.clicks;
      wk.set(k, w);
    }
    const days = [...activeDays].sort();
    out.push({
      id, name, campaign, status,
      firstDay: days[0] || "", lastDay: days[days.length - 1] || "", daysActive: days.length,
      spend, impressions, clicks, engagements,
      ctr: impressions ? clicks / impressions : 0,
      cpc: clicks ? spend / clicks : 0,
      cpm: impressions ? (spend / impressions) * 1000 : 0,
      cpe: engagements ? spend / engagements : 0,
      engRate: impressions ? engagements / impressions : 0,
      weekly: [...wk.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-30)
        .map(([week, w]) => ({ week, ctr: w.impr ? w.clicks / w.impr : 0, spend: w.spend, impressions: w.impr })),
    });
  }
  return out.filter((r) => r.spend > 0 || r.impressions > 0).sort((a, b) => b.spend - a.spend).slice(0, 100);
}

export async function xAdsEffectiveness(from: string, to: string): Promise<XAdsEffectiveness> {
  const [campRows, adRows] = await Promise.all([getDailyRows(from, to), getAdDailyRows(from, to)]);
  const campaigns = buildEff(campRows.map((r) => ({
    id: r.campaignId, name: r.name, campaign: "", status: r.status, date: r.date,
    spend: r.spend, impressions: r.impressions, clicks: r.clicks, engagements: r.engagements,
  })));
  const ads = buildEff(adRows.map((r) => ({
    id: r.adId, name: r.adName, campaign: r.campaignName, status: r.status, date: r.date,
    spend: r.spend, impressions: r.impressions, clicks: r.clicks, engagements: r.engagements,
  })));
  return { from, to, campaigns, ads };
}

// X-attributed self-reported leads. The form label is "X / Twitter"; tolerate the
// handful of free-text variants ("Twitter", "X", "twitter") the historical export holds.
function xLeads(selfReportedSource: { label: string; value: number }[]): number {
  return selfReportedSource
    .filter((r) => {
      const l = r.label.trim().toLowerCase();
      return l === "x / twitter" || l === "x" || l === "twitter";
    })
    .reduce((a, r) => a + r.value, 0);
}

// Build the full X Ads report over an ET day range [from, to] (YYYY-MM-DD inclusive),
// reading from the local cache when available (live API fallback otherwise).
export async function xAdsReport(from: string, to: string): Promise<XAdsReport> {
  const dates = dateRange(from, to);
  const rows = await getDailyRows(from, to);

  // Per-campaign + per-day accumulators.
  type Agg = { spend: number; impressions: number; clicks: number; engagements: number };
  const blank = (): Agg => ({ spend: 0, impressions: 0, clicks: 0, engagements: 0 });
  const byCampaign = new Map<string, Agg>();
  const byDate = new Map<string, Agg>();
  for (const d of dates) byDate.set(d, blank());
  const nameById = new Map<string, string>();
  const statusById = new Map<string, string>();

  for (const r of rows) {
    if (!byDate.has(r.date)) continue; // guard against any out-of-range cache row
    nameById.set(r.campaignId, r.name);
    statusById.set(r.campaignId, r.status);
    const cAgg = byCampaign.get(r.campaignId) || blank();
    cAgg.spend += r.spend; cAgg.impressions += r.impressions; cAgg.clicks += r.clicks; cAgg.engagements += r.engagements;
    byCampaign.set(r.campaignId, cAgg);
    const dAgg = byDate.get(r.date)!;
    dAgg.spend += r.spend; dAgg.impressions += r.impressions; dAgg.clicks += r.clicks; dAgg.engagements += r.engagements;
  }

  // Totals.
  let spend = 0, impressions = 0, clicks = 0, engagements = 0;
  for (const a of byCampaign.values()) {
    spend += a.spend; impressions += a.impressions; clicks += a.clicks; engagements += a.engagements;
  }
  const totals: XAdsTotals = {
    spend, impressions, clicks, engagements,
    cpc: clicks ? spend / clicks : 0,
    cpm: impressions ? (spend / impressions) * 1000 : 0,
    ctr: impressions ? clicks / impressions : 0,
  };

  const campaignRows: XAdsCampaign[] = [...byCampaign.entries()]
    .map(([id, a]) => ({
      id,
      name: nameById.get(id) || id,
      status: statusById.get(id) || "",
      spend: a.spend,
      impressions: a.impressions,
      clicks: a.clicks,
      engagements: a.engagements,
      cpc: a.clicks ? a.spend / a.clicks : 0,
    }))
    .filter((c) => c.spend > 0 || c.impressions > 0) // drop campaigns with no activity in window
    .sort((a, b) => b.spend - a.spend);

  const trend: XAdsDaily[] = dates.map((date) => {
    const a = byDate.get(date)!;
    return { date, spend: a.spend, impressions: a.impressions, clicks: a.clicks };
  });

  // ── ROI — pair spend against X-attributed leads from the core funnel ─────────
  const roi: XAdsRoi = { leads: null, totalLeads: null, costPerLead: null, gaConfigured: gaConfigured() };
  if (gaConfigured()) {
    try {
      const core = await analyticsReport("core", from, to);
      if (core.tranche === "core") {
        const leads = xLeads(core.selfReportedSource);
        const totalLeads = core.selfReportedSource.reduce((a, r) => a + r.value, 0);
        roi.leads = leads;
        roi.totalLeads = totalLeads;
        roi.costPerLead = leads > 0 ? spend / leads : null;
      }
    } catch {
      /* leave roi leads null — spend still renders */
    }
  }

  return { totals, byCampaign: campaignRows, trend, roi, campaignCount: campaignRows.length };
}

// ── Ad Lift (incrementality) ─────────────────────────────────────────────────
// Most X spend boosts organic POSTS (no UTM click-through), so per-campaign click
// attribution doesn't apply. Instead we measure lift: pick a channel's baseline
// traffic on days X ads are dark, then credit the excess on ad-running days to the
// ads. Done per channel and day-of-week-matched (traffic is weekly-seasonal), so
// each ad day is compared to the mean of dark days with the SAME weekday.
//
// The clean signal lives in the social channels (Organic Social / Unassigned /
// Organic Video) — Direct/type-in is dominated by the marketplace business and
// swamps the ad effect, so it's offered but not credited by default. Computed over
// a trailing window (default 90 days, independent of the spend selector) so there
// are always enough dark days to form a baseline.

export const LIFT_DEFAULT_CHANNELS = ["Organic Social", "Unassigned", "Organic Video"];
const LIFT_SPEND_MIN = 1; // $1+ billed in a day ⇒ an "ad-running" day

export type LiftChannel = {
  channel: string;
  baselinePerDay: number; // mean sessions on dark days
  adPerDay: number; // mean sessions on ad days
  incrementalVisits: number; // DoW-matched lift summed over ad days
};
export type XAdsLift = {
  from: string;
  to: string;
  lookbackDays: number;
  adDays: number;
  offDays: number;
  spend: number; // X spend on ad days within the lift window
  channels: LiftChannel[];
  defaultChannels: string[];
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const dow = (ymd: string) => new Date(ymd + "T00:00:00Z").getUTCDay();

export async function xAdsLift(to: string, lookbackDays = 90): Promise<XAdsLift> {
  const from = addDays(to, -(lookbackDays - 1));
  const dates = dateRange(from, to);

  // Daily spend (cache-first) + GA daily channel sessions, in parallel.
  const [rows, gaRows] = await Promise.all([
    getDailyRows(from, to),
    dailyChannelSessions(from, to),
  ]);
  const spendByDay = new Map<string, number>(dates.map((d) => [d, 0]));
  for (const r of rows) if (spendByDay.has(r.date)) spendByDay.set(r.date, spendByDay.get(r.date)! + r.spend);

  // sessions[date][channel], restricted to days GA actually reported (so a not-yet-
  // populated tail or pre-tracking head doesn't read as zero-traffic dark days).
  const byDayCh = new Map<string, Map<string, number>>();
  const channels = new Set<string>();
  for (const r of gaRows) {
    channels.add(r.channel);
    if (!byDayCh.has(r.date)) byDayCh.set(r.date, new Map());
    byDayCh.get(r.date)!.set(r.channel, (byDayCh.get(r.date)!.get(r.channel) || 0) + r.sessions);
  }
  const covered = dates.filter((d) => byDayCh.has(d));
  const adDays = covered.filter((d) => (spendByDay.get(d) || 0) >= LIFT_SPEND_MIN);
  const offDays = covered.filter((d) => (spendByDay.get(d) || 0) < LIFT_SPEND_MIN);
  const spend = adDays.reduce((a, d) => a + (spendByDay.get(d) || 0), 0);
  const sess = (d: string, c: string) => byDayCh.get(d)?.get(c) || 0;

  const liftChannels: LiftChannel[] = [...channels]
    .map((c) => {
      const baselinePerDay = mean(offDays.map((d) => sess(d, c)));
      const adPerDay = mean(adDays.map((d) => sess(d, c)));
      // Day-of-week-matched: each ad day vs the mean of dark days sharing its weekday
      // (fallback to the overall baseline when no same-weekday dark day exists).
      let incrementalVisits = 0;
      for (const d of adDays) {
        const peers = offDays.filter((x) => dow(x) === dow(d)).map((x) => sess(x, c));
        incrementalVisits += sess(d, c) - (peers.length ? mean(peers) : baselinePerDay);
      }
      return { channel: c, baselinePerDay, adPerDay, incrementalVisits };
    })
    .sort((a, b) => b.adPerDay - a.adPerDay);

  return {
    from: covered[0] || from,
    to,
    lookbackDays,
    adDays: adDays.length,
    offDays: offDays.length,
    spend,
    channels: liftChannels,
    defaultChannels: LIFT_DEFAULT_CHANNELS.filter((c) => channels.has(c)),
  };
}
