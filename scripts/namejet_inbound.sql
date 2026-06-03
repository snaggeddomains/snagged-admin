-- Stash table for the NameJet daily backorder email (naming project:
-- snagged-naming-universe). The Resend Inbound webhook (/api/inbound/namejet)
-- fetches the email body via Resend's Retrieve API (the email.received webhook
-- is metadata-only) and inserts it here; the namejet_email_digest source reads
-- the latest un-processed row on the daily auctions run, then stamps processed_at.
create table if not exists public.namejet_inbound (
  id              uuid primary key default gen_random_uuid(),
  received_at     timestamptz not null default now(),
  email_id        text,           -- Resend email id (for re-fetch / dedupe)
  sender          text,
  subject         text,
  html            text,
  text            text,
  processed_at    timestamptz,
  listings_count  int
);

-- Already created the table from an earlier version? Add the column:
alter table public.namejet_inbound add column if not exists email_id text;

-- The source fetches the most recent un-processed email.
create index if not exists idx_namejet_inbound_unprocessed
  on public.namejet_inbound (received_at desc)
  where processed_at is null;

-- RLS on with no policies (the service_role key bypasses) — matches the
-- project's no-anon-access posture for every other table.
alter table public.namejet_inbound enable row level security;
