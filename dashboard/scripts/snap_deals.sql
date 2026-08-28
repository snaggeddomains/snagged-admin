-- SNAP Deals — a lean internal board for tracking names SNAP (Sam) is trying to ACQUIRE.
-- Separate from the buy-side `deals` CRM: its own table, its own single `snap.deals`
-- permission, a shared board (no per-owner scoping / assignment / inbox). Run once on the
-- MAIN project (admin SUPABASE_URL). The service key bypasses RLS.

create table if not exists snap_deals (
  id            uuid primary key default gen_random_uuid(),
  domain        text not null,
  point_person  text,                 -- who's running point on this name (free text; usually Sam)
  owner_info    text,                 -- the name's owner / who we're negotiating with (name + contact, free text)
  asking_price  numeric,              -- seller's asking / our target acquisition price
  current_offer numeric,             -- latest offer on the table
  priority      text,                 -- Top / High / Normal / Low
  stage         text not null default 'Qualifying',
  status        text not null default 'open',   -- open | won | dropped
  drop_reason   text,                 -- why we passed (set when status=dropped)
  notes         text,
  position      int,                  -- manual order within a column
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_snap_deals_stage on snap_deals (stage);
create index if not exists idx_snap_deals_status on snap_deals (status);

-- Per-deal progress log — timestamped notes + auto stage/status changes, so Sam can see
-- how a name has moved over time.
create table if not exists snap_deal_activity (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references snap_deals(id) on delete cascade,
  user_email  text,
  kind        text not null default 'note',   -- note | created | stage_change | status_change
  body        text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_snap_deal_activity_deal on snap_deal_activity (deal_id, created_at);

alter table snap_deals enable row level security;
alter table snap_deal_activity enable row level security;
