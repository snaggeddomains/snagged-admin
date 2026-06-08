// Local cache of X (Twitter) Ads daily metrics — the durable fix for the Ads tab's
// slowness / rate-limit (429) / timeout. X spend per campaign per day is append-only
// history (X finalizes billing within a few days, then it never changes), so instead
// of re-fetching the whole history live on every page view we snapshot it to Supabase
// once via a cron (/api/cron/x-ads-sync) and the report reads from the table.
//
// Lives in the snagged-admin admin Supabase (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
// — the same project that backs the import-history log, NOT the naming/master corpora.
// One row per (date, campaign_id); campaign name/status are denormalized in (they're
// stable and save a join). RLS is enabled with no policies; the service key bypasses.
//
// One-time setup SQL — scripts/x_ads_cache.sql:
//   create table if not exists x_ads_daily (
//     date date not null, campaign_id text not null, campaign_name text, status text,
//     spend numeric not null default 0, impressions bigint not null default 0,
//     clicks bigint not null default 0, engagements bigint not null default 0,
//     updated_at timestamptz not null default now(),
//     primary key (date, campaign_id));
//   create index if not exists idx_x_ads_daily_date on x_ads_daily (date);
//   alter table x_ads_daily enable row level security;

import { getDb, isDbConfigured } from "./supabase";

export type XAdsDailyRow = {
  date: string; // YYYY-MM-DD (ET)
  campaignId: string;
  name: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  engagements: number;
};

// Per-ad (promoted tweet) daily row — same metrics plus campaign + creative labels.
export type XAdsAdDailyRow = {
  date: string;
  adId: string;
  campaignId: string;
  campaignName: string;
  adName: string; // tweet text snippet
  tweetId: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  engagements: number;
};

export function xAdsStoreConfigured(): boolean {
  return isDbConfigured();
}

type DbRow = {
  date: string; campaign_id: string; campaign_name: string | null; status: string | null;
  spend: number | string | null; impressions: number | null; clicks: number | null; engagements: number | null;
};
const n = (v: number | string | null): number => {
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
};

// Read cached daily rows for [from, to] inclusive. Returns [] (and the caller falls
// back to the live API) if the cache is unconfigured, empty, or errors.
export async function readDailyRows(from: string, to: string): Promise<XAdsDailyRow[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb()
    .from("x_ads_daily")
    .select("date,campaign_id,campaign_name,status,spend,impressions,clicks,engagements")
    .gte("date", from)
    .lte("date", to);
  if (error || !data) return [];
  return (data as DbRow[]).map((r) => ({
    date: String(r.date).slice(0, 10),
    campaignId: r.campaign_id,
    name: r.campaign_name || r.campaign_id,
    status: r.status || "",
    spend: n(r.spend),
    impressions: n(r.impressions),
    clicks: n(r.clicks),
    engagements: n(r.engagements),
  }));
}

// Upsert daily rows onto (date, campaign_id) — finalized days stay put, recent days
// get corrected as X revises them. Chunked to keep the request body sane.
export async function upsertDailyRows(rows: XAdsDailyRow[]): Promise<number> {
  if (!isDbConfigured() || !rows.length) return 0;
  const db = getDb();
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map((r) => ({
      date: r.date, campaign_id: r.campaignId, campaign_name: r.name, status: r.status,
      spend: r.spend, impressions: r.impressions, clicks: r.clicks, engagements: r.engagements,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await db.from("x_ads_daily").upsert(batch, { onConflict: "date,campaign_id" });
    if (error) throw new Error(`x_ads_daily upsert: ${error.message}`);
    written += batch.length;
  }
  return written;
}

type AdDbRow = {
  date: string; ad_id: string; campaign_id: string | null; campaign_name: string | null;
  ad_name: string | null; tweet_id: string | null; status: string | null;
  spend: number | string | null; impressions: number | null; clicks: number | null; engagements: number | null;
};

// Read cached per-ad daily rows for [from, to] inclusive.
export async function readAdDailyRows(from: string, to: string): Promise<XAdsAdDailyRow[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb()
    .from("x_ads_ad_daily")
    .select("date,ad_id,campaign_id,campaign_name,ad_name,tweet_id,status,spend,impressions,clicks,engagements")
    .gte("date", from)
    .lte("date", to);
  if (error || !data) return [];
  return (data as AdDbRow[]).map((r) => ({
    date: String(r.date).slice(0, 10),
    adId: r.ad_id,
    campaignId: r.campaign_id || "",
    campaignName: r.campaign_name || "",
    adName: r.ad_name || r.ad_id,
    tweetId: r.tweet_id || "",
    status: r.status || "",
    spend: n(r.spend),
    impressions: n(r.impressions),
    clicks: n(r.clicks),
    engagements: n(r.engagements),
  }));
}

// Upsert per-ad daily rows onto (date, ad_id).
export async function upsertAdDailyRows(rows: XAdsAdDailyRow[]): Promise<number> {
  if (!isDbConfigured() || !rows.length) return 0;
  const db = getDb();
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map((r) => ({
      date: r.date, ad_id: r.adId, campaign_id: r.campaignId, campaign_name: r.campaignName,
      ad_name: r.adName, tweet_id: r.tweetId, status: r.status,
      spend: r.spend, impressions: r.impressions, clicks: r.clicks, engagements: r.engagements,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await db.from("x_ads_ad_daily").upsert(batch, { onConflict: "date,ad_id" });
    if (error) throw new Error(`x_ads_ad_daily upsert: ${error.message}`);
    written += batch.length;
  }
  return written;
}
