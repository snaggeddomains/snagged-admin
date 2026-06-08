-- Per-ad (promoted tweet) daily metrics cache — powers the per-ad effectiveness
-- breakdown in the Ads tab. Same admin Supabase project as x_ads_daily.
-- One row per (date, ad_id); campaign + creative labels denormalized in.
-- Synced alongside x_ads_daily by /api/cron/x-ads-sync.

create table if not exists x_ads_ad_daily (
  date          date    not null,
  ad_id         text    not null,   -- promoted_tweet id
  campaign_id   text,
  campaign_name text,
  ad_name       text,               -- tweet text snippet (creative label)
  tweet_id      text,
  status        text,
  spend         numeric not null default 0,
  impressions   bigint  not null default 0,
  clicks        bigint  not null default 0,
  engagements   bigint  not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (date, ad_id)
);

create index if not exists idx_x_ads_ad_daily_date on x_ads_ad_daily (date);
create index if not exists idx_x_ads_ad_daily_campaign on x_ads_ad_daily (campaign_id);

alter table x_ads_ad_daily enable row level security;

-- After running this, backfill in segments (same as x_ads_daily), e.g.:
--   curl -H "Authorization: Bearer $CRON_SECRET" \
--     "https://app.snagged.com/api/cron/x-ads-sync?from=2023-06-01&to=2024-06-01"
-- (the cron now syncs both the campaign and the ad tables).
