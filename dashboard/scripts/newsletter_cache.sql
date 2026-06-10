-- Cache for "which domains were featured in which MailChimp send" — powers the
-- Newsletter counts on the Marketplace report. A cron (/api/cron/newsletter-sync)
-- scans each sent campaign's HTML body, keeps only current marketplace listings,
-- and upserts here; the report reads from this cache (scanning ~130 bodies live
-- is too slow). Lives in the admin Supabase (SUPABASE_URL / SERVICE_ROLE_KEY).
-- RLS on, no policies (the service key bypasses).
create table if not exists newsletter_features (
  domain       text not null,
  campaign_id  text not null,
  send_date    date,
  subject      text,
  type         text not null default 'content', -- 'for_sale' (Monthly Spotlight) | 'content'
  primary key (domain, campaign_id)
);
create index if not exists idx_newsletter_features_domain on newsletter_features (domain);

create table if not exists newsletter_scanned (
  campaign_id  text primary key,
  send_date    date
);

alter table newsletter_features enable row level security;
alter table newsletter_scanned  enable row level security;
