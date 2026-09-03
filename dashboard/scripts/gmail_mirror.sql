-- Local Gmail MIRROR — a Postgres copy of the deal mailboxes so our features query LOCALLY
-- instead of hitting the throttled Gmail API. Seeded by a one-time Takeout MBOX import
-- (quota-free), kept fresh by cheap History-API deltas. Run once on the
-- domain-owner-research (PRODUCTION) project — the one with the other domain_research_* /
-- deals tables, NOT snagged-naming-universe.
-- Idempotent.

create extension if not exists pg_trgm;

create table if not exists gmail_messages (
  mailbox      text        not null,             -- rob@snagged.com etc.
  id           text        not null,             -- Gmail message id (or a stable synthetic for MBOX-only)
  thread_id    text,                             -- Gmail thread id (X-GM-THRID from MBOX; message-id fallback)
  mid          text,                             -- RFC Message-ID (dedupe across mailboxes)
  from_addr    text,                             -- bare lowercased sender
  from_name    text,
  to_addr      text,                             -- raw To header (may hold several)
  cc           text,
  subject      text,
  ts           timestamptz,                      -- message date
  snippet      text,
  body         text,                             -- text/plain (html-stripped fallback), no attachments
  labels       text[],
  size_est     bigint      not null default 0,   -- approx bytes (for thread-size guards)
  bulk         boolean     not null default false,
  -- bounded search column: subject + from + to + first 8KB of body, lowercased. trgm-indexed so
  -- ILIKE '%domain%' / from/subject filters are fast without a giant full-body index.
  search_text  text,
  imported_at  timestamptz not null default now(),
  primary key (mailbox, id)
);

create index if not exists idx_gmail_msgs_thread   on gmail_messages (mailbox, thread_id);
create index if not exists idx_gmail_msgs_ts        on gmail_messages (mailbox, ts desc);
create index if not exists idx_gmail_msgs_mid       on gmail_messages (mid);
create index if not exists idx_gmail_msgs_search_trgm on gmail_messages using gin (search_text gin_trgm_ops);

alter table gmail_messages enable row level security;  -- service key bypasses; no anon policy

-- Per-mailbox sync state: the History cursor + backfill bookkeeping.
create table if not exists gmail_sync_state (
  mailbox        text primary key,
  last_history_id text,                          -- Gmail historyId watermark for incremental sync
  last_synced_at timestamptz,
  backfill_done  boolean not null default false,
  backfill_source text,                          -- 'takeout-mbox' | 'api'
  message_count  integer not null default 0,
  updated_at     timestamptz not null default now()
);

alter table gmail_sync_state enable row level security;

-- Refresh PostgREST's schema cache so the REST API (supabase-js) sees the new tables immediately.
-- Without this, the first ingest can 404 with "Could not find the table 'public.gmail_messages'
-- in the schema cache" until PostgREST reloads on its own. Safe + idempotent to re-run.
notify pgrst, 'reload schema';
