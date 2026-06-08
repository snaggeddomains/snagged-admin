-- One-time setup for the X (Twitter) Ads daily-metrics cache.
-- Run in the snagged-admin ADMIN Supabase project (the one behind SUPABASE_URL /
-- SUPABASE_SERVICE_ROLE_KEY — same project as the import-history log), NOT the
-- naming/master/zone corpora.
--
-- One row per (date, campaign_id); campaign name/status are denormalized in.
-- The /api/cron/x-ads-sync job upserts onto the primary key, so finalized days
-- stay put while recent days are corrected as X revises billing.

create table if not exists x_ads_daily (
  date          date    not null,
  campaign_id   text    not null,
  campaign_name text,
  status        text,
  spend         numeric not null default 0,   -- USD (billed_charge_local_micro / 1e6)
  impressions   bigint  not null default 0,
  clicks        bigint  not null default 0,
  engagements   bigint  not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (date, campaign_id)
);

create index if not exists idx_x_ads_daily_date on x_ads_daily (date);

-- RLS on, no policies: our app uses the service_role key (bypasses RLS), so this
-- just closes anon/public access (matches the rest of the admin tables).
alter table x_ads_daily enable row level security;

-- After running this, backfill history once (with the cron secret), then the
-- thrice-daily cron keeps it current:
--   curl -H "Authorization: Bearer $CRON_SECRET" \
--     "https://app.snagged.com/api/cron/x-ads-sync?days=1200"
