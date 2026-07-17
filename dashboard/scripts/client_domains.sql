-- Client Domain Overlap — corpus + flags tables (MAIN admin project: SUPABASE_URL).
-- Run once in the Supabase SQL editor of the admin/research project (the same
-- project getDb() points at, where domain_research_* + marketplace_deal_reports live).
-- RLS is enabled with NO policies: the service_role key bypasses it, anon is denied
-- (matches every other table in this project).

-- ── The master corpus: every client-associated domain, deduped to apex ──────────
-- Rebuilt daily by the corpus builder (lib/domain-corpus/build.ts). This is the
-- SOURCE OF TRUTH the overlap matcher reads; the Client Domain Names Google Sheet
-- is a mirror written from this table.
create table if not exists client_domains (
  domain             text primary key,          -- canonical apex (lowercased)
  sld                text not null,              -- second-level label (matching key)
  tld                text not null,              -- bare tld (no leading dot)
  clients            text[] not null default '{}',   -- merged human client/contact labels
  sources            text[] not null default '{}',   -- provenance tags: [Payments] [Master Txns List] ...
  notes              text,                       -- concatenated tagged note blocks
  last_contact_date  date,                       -- newest useful date across all evidence
  first_source_date  date,                       -- earliest known source date
  date_added         date not null,              -- spec continuity field (earliest source date), preserved across rebuilds
  first_ingested_at  date,                       -- the day THIS builder first wrote the row (net-new tracking)
  updated_at         timestamptz not null default now()
);
create index if not exists idx_client_domains_sld on client_domains (sld);
create index if not exists idx_client_domains_ingested on client_domains (first_ingested_at);

alter table client_domains enable row level security;

-- ── Build-run log: one row per corpus rebuild, for the "names added" history + the
-- freshness (green-dot) indicator on the Reports tab. ──────────────────────────
create table if not exists client_domain_build_runs (
  id            uuid primary key default gen_random_uuid(),
  run_at        timestamptz not null default now(),
  run_date      date not null,
  added_count   integer not null default 0,      -- net-new domains this run
  total_count   integer not null default 0,      -- corpus size after the run
  source_counts jsonb not null default '{}',     -- {"[Payments]": 1234, "[Gmail:...]": 87, ...}
  gmail_days    integer,
  ok            boolean not null default true,
  error         text
);
create index if not exists idx_build_runs_at on client_domain_build_runs (run_at desc);

alter table client_domain_build_runs enable row level security;

-- ── Overlap flags: ONE row per candidate_domain (the current match set) ─────────
-- Written by the overlap matcher (upsert; dismissals + first_flagged_at preserved);
-- read by the Reports tab + digest. Keyed by candidate_domain so a re-run refreshes
-- the set in place instead of accumulating a row per day.
create table if not exists client_domain_overlap_flags (
  candidate_domain text primary key,
  candidate_sld    text not null,
  candidate_tld    text not null,
  best_tier        text not null,                -- 'exact_tld' (T1) | 'affix' (T2)
  clients          text[] not null default '{}', -- flattened unique client labels of the matched anchors
  matches          jsonb not null default '[]',  -- [{anchor, clients[], tier, affix}]
  source_feed      text,                         -- which feed surfaced the candidate (afternic/atom/…)
  price            numeric,
  price_source     text,
  link             text,
  kind             text not null default 'sale', -- 'sale' (marketplace) | 'auction' (time-sensitive)
  ends_at          timestamptz,                  -- auction end time (urgency), else null
  dismissed        boolean not null default false,
  first_flagged_at date not null default current_date,
  last_seen_at     date not null default current_date,
  created_at       timestamptz not null default now()
);
create index if not exists idx_overlap_flags_open on client_domain_overlap_flags (dismissed, first_flagged_at desc);

-- Auction delineation (add to an already-existing flags table; safe to re-run).
alter table client_domain_overlap_flags add column if not exists kind text not null default 'sale';
alter table client_domain_overlap_flags add column if not exists ends_at timestamptz;

alter table client_domain_overlap_flags enable row level security;
