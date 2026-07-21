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
  asking_price      numeric,
  source            text,
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

-- If `deals` already existed before budget_max was added, this backfills the column.
alter table deals add column if not exists budget_max numeric;

-- Per-user deal notification preferences ({deal:{in_app,email,slack}}), default all on.
alter table domain_research_users add column if not exists notif_prefs jsonb;

alter table deals enable row level security;
alter table deal_activity enable row level security;
alter table deal_emails enable row level security;
