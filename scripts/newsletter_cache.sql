-- Newsletter feature cache — which CURRENT marketplace listings were featured in
-- which MailChimp sends. Scanning ~130 campaign bodies live is too slow per report
-- view, so a cron (/api/cron/newsletter-sync) scans each sent campaign's HTML body
-- once, keeps only domains that are current /marketplace listings, and upserts here.
-- The Marketplace report reads from this table (fast).
--
-- Lives in the snagged-admin admin Supabase (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
-- — same project as x_ads_daily + the import log. RLS on, no policies (service key
-- bypasses). One row per (domain, campaign_id).
--   type:  'for_sale' = the monthly "Domain Spotlight" / "[New Domains]" send
--          'content'  = the weekly story send (listing mentioned in the body/CTA)

create table if not exists newsletter_features (
  domain        text not null,
  campaign_id   text not null,
  send_date     date,
  subject       text,
  type          text not null default 'content',
  updated_at    timestamptz not null default now(),
  primary key (domain, campaign_id)
);
create index if not exists idx_newsletter_features_domain on newsletter_features (domain);
-- Lets the sync skip campaigns it has already scanned (incremental backfill).
create index if not exists idx_newsletter_features_campaign on newsletter_features (campaign_id);

alter table newsletter_features enable row level security;

-- Records every campaign we've SCANNED (even those that featured no current listing),
-- so the incremental sync never re-fetches the same body twice.
create table if not exists newsletter_scanned (
  campaign_id text primary key,
  send_date   date,
  scanned_at  timestamptz not null default now()
);
alter table newsletter_scanned enable row level security;
