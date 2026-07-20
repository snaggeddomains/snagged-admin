-- Social Sweep — scored domain-opportunity posts skimmed from Reddit (and X).
-- Run once in the MAIN admin project (SUPABASE_URL — same project as client_domains
-- + marketplace_deal_reports). RLS enabled with NO policies (service_role bypasses;
-- anon denied), matching every other table here.

create table if not exists social_sweep_posts (
  id            text primary key,               -- `${platform}:${link}`
  platform      text not null default 'reddit', -- 'reddit' | 'x'
  source        text not null,                  -- subreddit (reddit) or query/handle (x)
  title         text,
  link          text not null,
  author        text,
  published     timestamptz,
  score         integer not null default 0,
  bucket        text not null,                  -- 'high-signal' | 'maybe'
  buy_side      boolean not null default false,
  sell_side     boolean not null default false,
  matched       text[] not null default '{}',   -- the terms that fired (the "why")
  sample        text,                           -- advisory suggested-response angle
  snippet       text,
  dismissed     boolean not null default false,
  first_seen_at date not null default current_date,
  last_seen_at  date not null default current_date,
  created_at    timestamptz not null default now()
);
create index if not exists idx_social_sweep_open
  on social_sweep_posts (platform, dismissed, bucket, first_seen_at desc);

-- VIP signal (X): author follower count + verified. Safe to re-run.
alter table social_sweep_posts add column if not exists author_followers integer;
alter table social_sweep_posts add column if not exists author_verified boolean not null default false;
-- LLM-drafted suggested reply in Snagged's voice (channel-aware). Safe to re-run.
alter table social_sweep_posts add column if not exists suggested_reply text;

alter table social_sweep_posts enable row level security;

-- Per-run log for the freshness (green-dot) indicator + feed-error surfacing.
create table if not exists social_sweep_runs (
  id          uuid primary key default gen_random_uuid(),
  run_at      timestamptz not null default now(),
  platform    text not null,
  fetched     integer not null default 0,
  scored      integer not null default 0,
  high        integer not null default 0,
  maybe       integer not null default 0,
  new_count   integer not null default 0,
  feed_errors text[] not null default '{}',
  ok          boolean not null default true,
  error       text
);
create index if not exists idx_social_sweep_runs_at on social_sweep_runs (run_at desc);

alter table social_sweep_runs enable row level security;

-- Muted authors — their posts never surface in the sweep (any platform), keyed by
-- the lowercased handle. Filtered at display (listPosts) AND ingest (run/x-run skip
-- them before the LLM reply-draft). Degrades gracefully (empty) until this is run.
create table if not exists social_sweep_muted (
  author     text primary key,
  platform   text,
  muted_by   text,
  created_at timestamptz not null default now()
);

alter table social_sweep_muted enable row level security;
