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

-- ── Overlap flags: one row per (run_date, candidate) with its matched anchors ────
-- Written by the overlap matcher; read by the Reports tab + daily digest.
create table if not exists client_domain_overlap_flags (
  id               uuid primary key default gen_random_uuid(),
  run_date         date not null,
  candidate_domain text not null,
  candidate_sld    text not null,
  candidate_tld    text not null,
  best_tier        text not null,                -- 'exact_tld' (T1) | 'affix' (T2)
  clients          text[] not null default '{}', -- flattened unique client labels of the matched anchors
  matches          jsonb not null default '[]',  -- [{anchor, clients[], tier, affix}]
  source_feed      text,                         -- which feed surfaced the candidate (afternic/atom/auctions/…)
  price            numeric,
  price_source     text,
  link             text,
  dismissed        boolean not null default false,
  created_at       timestamptz not null default now(),
  unique (run_date, candidate_domain)
);
create index if not exists idx_overlap_flags_run on client_domain_overlap_flags (run_date desc);
create index if not exists idx_overlap_flags_open on client_domain_overlap_flags (dismissed, run_date desc);

alter table client_domain_overlap_flags enable row level security;
