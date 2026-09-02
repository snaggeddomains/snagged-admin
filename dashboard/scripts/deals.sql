-- Native buy-side Deals CRM (replaces the Pipedrive integration). Lives in the main
-- project (admin SUPABASE_URL == research main). Run once in that project's SQL editor.
-- RLS is enabled with no policies — the service_role key (what the app uses) bypasses
-- RLS, so this closes the public advisor without affecting the app.

create extension if not exists pgcrypto;

-- One row per deal. Stage drives the board column; status is the terminal state.
create table if not exists deals (
  id                uuid primary key default gen_random_uuid(),
  domain            text not null,
  additional_domains text,
  buyer_name        text,
  buyer_email       text,
  buyer_phone       text,
  org_name          text,
  budget_range      text,
  appraisal_value   numeric,
  asking_price      numeric,                             -- latest OWNER asking price
  current_offer     numeric,                             -- latest CLIENT offer (shown side-by-side with asking for at-a-glance gap)
  source            text,
  heard_about       text,                              -- "How did you hear about us?" form attribution (e.g. "X / Twitter")
  priority          text,                              -- Top | High | Normal | Low
  budget_max        numeric,                           -- band ceiling for sort/search (5000/25000/50000/100000/100000000)
  owner_email       text,                              -- assignee (our user's email); null = Inbox
  stage             text not null default 'Unassigned / Inbox',
  status            text not null default 'open',      -- open | won | lost
  lost_reason       text,
  report_link       text,
  likely_owner      text,
  owner_contact     text,
  reachability      text,
  notes             text,
  tags              text[] default '{}',
  lead_key          text,                              -- origin inbound inquiry, when converted from triage
  created_by        text,
  position          double precision default 0,        -- order within a stage column (fractional reindex)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_deals_stage on deals (stage, position);
create index if not exists idx_deals_owner on deals (owner_email);
create index if not exists idx_deals_status on deals (status);
create index if not exists idx_deals_domain on deals (lower(domain));
-- Idempotency for the triage/research convert: same buyer + domain shouldn't duplicate.
create unique index if not exists uq_deals_domain_buyer
  on deals (lower(domain), lower(coalesce(buyer_email, '')));

-- Timeline: notes, comments (with @mentions in meta), stage/status/assignment/field
-- changes, and email-ingested markers. One table so the detail view is a single feed.
create table if not exists deal_activity (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals(id) on delete cascade,
  user_email  text,                                    -- actor; null = system
  kind        text not null,                           -- note | comment | stage_change | status_change | assignment | field_change | email | created
  body        text,
  meta        jsonb,                                   -- {from,to} / {mentions:[email]} / {field}
  created_at  timestamptz not null default now()
);
create index if not exists idx_deal_activity_deal on deal_activity (deal_id, created_at);

-- Gmail threads auto-pulled per deal (by buyer email / domain), reusing lib/gmail.ts.
create table if not exists deal_emails (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals(id) on delete cascade,
  mailbox     text,
  thread_id   text not null,
  subject     text,
  snippet     text,
  body        text,
  from_addr   text,
  msg_date    timestamptz,
  ingested_at timestamptz not null default now(),
  unique (deal_id, thread_id)
);
create index if not exists idx_deal_emails_deal on deal_emails (deal_id, msg_date desc);

-- Per-MESSAGE email timeline (one row per email, not per thread — the full back-and-forth).
-- Add msg_id, drop the old thread-unique constraint, add a per-message unique index.
alter table deal_emails add column if not exists msg_id text;
alter table deal_emails drop constraint if exists deal_emails_deal_id_thread_id_key;
create unique index if not exists deal_emails_deal_msg on deal_emails (deal_id, msg_id);

-- If `deals` already existed before budget_max was added, this backfills the column.
alter table deals add column if not exists budget_max numeric;
alter table deals add column if not exists heard_about text;

-- Close-Won capture: final price paid + our commission.
alter table deals add column if not exists sale_price numeric;
alter table deals add column if not exists commission numeric;

-- Latest client offer — shown side-by-side with the owner's asking price on the deal page so the
-- price gap ("where we're at") reads at a glance.
alter table deals add column if not exists current_offer numeric;

-- Upfront fee we charged the client to pursue the acquisition; upfront_paid auto-flips true
-- once the deal reaches the "Research & Outreach" stage.
alter table deals add column if not exists upfront_fee numeric;
alter table deals add column if not exists upfront_paid boolean default false;

-- "Sam splits upfront" flag — Sam takes a cut of the upfront fee on this deal. Permission-gated
-- toggle (deals.sam_split: Rob/Judy/Brian). sam_split_at stamps WHEN it was taken on, so monthly
-- reports can bucket by the month Sam took it (not the deal's creation month).
alter table deals add column if not exists sam_split boolean default false;
alter table deals add column if not exists sam_split_at timestamptz;
create index if not exists idx_deals_sam_split on deals (sam_split_at) where sam_split;

-- Per-user deal notification preferences ({deal:{in_app,email,slack}}), default all on.
alter table domain_research_users add column if not exists notif_prefs jsonb;

-- Owner intelligence directory — a persistent record of every domain owner we work with:
-- contact info, a general dossier, and how they've negotiated over time. Built over time,
-- seeded from a deal's researched "likely owner" and confirmed at the Negotiating stage
-- (when we're confident they truly own the name). A deal links to one owner via
-- deals.domain_owner_id, so an owner's detail aggregates every name/deal we've worked with them.
create table if not exists deal_owners (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,                 -- person or company display name
  kind              text default 'unknown',        -- person | company | unknown
  company           text,                          -- employer/org, if the owner is a person
  emails            text[] default '{}',
  phones            text[] default '{}',
  links             text[] default '{}',           -- profile / social / marketplace URLs
  reachability      text,                          -- how best to reach them
  notes             text,                          -- general dossier
  negotiation_notes text,                          -- how they negotiate (accrued over deals)
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_deal_owners_name on deal_owners (lower(name));
-- Link a deal to its confirmed owner (many deals → one owner).
alter table deals add column if not exists domain_owner_id uuid references deal_owners(id) on delete set null;
create index if not exists idx_deals_domain_owner on deals (domain_owner_id);
alter table deal_owners enable row level security;

-- Which research-derived owner fields the user MANUALLY edited (so they stop auto-syncing
-- from the research report; everything else auto-refreshes on view). e.g. {"likely_owner":true}.
alter table deals add column if not exists owner_manual jsonb;

-- Cron heartbeat — a tiny append-in-place log so we can SEE whether a scheduled job
-- actually fired (Vercel gives no in-app visibility). Each cron upserts its row at the end
-- of a run; the UI reads last_run_at to show "emails auto-synced N min ago".
create table if not exists cron_heartbeats (
  name         text primary key,
  last_run_at  timestamptz not null default now(),
  last_result  jsonb,
  updated_at   timestamptz not null default now()
);
alter table cron_heartbeats enable row level security;

-- Buy-Side Inquiries triage: let a reviewer dismiss/ignore a spam/test inquiry.
alter table domain_research_leads add column if not exists dismissed boolean default false;
alter table domain_research_leads add column if not exists dismissed_by text;
alter table domain_research_leads add column if not exists dismissed_at timestamptz;

-- ============================================================================
-- Deal SHARING + My Tasks (boomerangs) — 2026-07-28
-- ============================================================================

-- Share a deal with a colleague. Created explicitly (Share button) OR implicitly when
-- you @mention someone in a comment. A shared user gets VIEW + COMMENT access to that
-- deal (not edit / stage / reassign — the owner stays in control). One row per (deal,user).
create table if not exists deal_shares (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals(id) on delete cascade,
  user_email  text not null,                       -- lowercased
  shared_by   text,                                -- who granted access (email)
  created_at  timestamptz not null default now(),
  unique (deal_id, user_email)
);
create index if not exists idx_deal_shares_user on deal_shares (lower(user_email));
create index if not exists idx_deal_shares_deal on deal_shares (deal_id);
alter table deal_shares enable row level security;

-- Boomerang / snooze: a PERSONAL reminder to revisit a deal on a date (everyone sets their
-- own). Surfaces in My Tasks when remind_at passes; `done` clears it. One active reminder
-- per (deal,user) — setting a new one supersedes the prior active one.
create table if not exists deal_reminders (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals(id) on delete cascade,
  user_email  text not null,                       -- whose reminder (lowercased)
  remind_at   timestamptz not null,                -- when it boomerangs back
  note        text,                                -- optional "why"
  done        boolean not null default false,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_deal_reminders_due on deal_reminders (lower(user_email), done, remind_at);
create index if not exists idx_deal_reminders_deal on deal_reminders (deal_id, lower(user_email));
alter table deal_reminders enable row level security;

alter table deals enable row level security;
alter table deal_activity enable row level security;
alter table deal_emails enable row level security;
