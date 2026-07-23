-- Content cross-linking (SEO internal links) — the ranked opportunities from an Analyze run,
-- plus PERSISTENT feedback keyed by (source,target) so 👍/👎 survives re-runs and trains ranking.
-- Run once in the main project. RLS enabled (service key bypasses).

create extension if not exists pgcrypto;

-- One Analyze run over the blog corpus.
create table if not exists content_crosslink_runs (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running',   -- running | done | error
  posts         int,
  opportunities int,
  error         text,
  started_by    text
);

-- A single suggested link: from a phrase in the SOURCE post → the TARGET post.
create table if not exists content_crosslinks (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid references content_crosslink_runs(id) on delete cascade,
  source_id    text not null,        -- Webflow item id of the post the link goes IN
  source_title text,
  source_slug  text,
  target_id    text not null,        -- Webflow item id of the post it links TO
  target_title text,
  target_slug  text,
  anchor       text,                 -- the exact phrase in the source to turn into the link
  context      text,                 -- the surrounding sentence (so it's placeable)
  rationale    text,                 -- why it's relevant
  score        numeric,              -- 0-100 relevance
  status       text not null default 'suggested', -- suggested | inserted | dismissed
  created_at   timestamptz not null default now()
);
create index if not exists idx_crosslinks_run on content_crosslinks (run_id, score desc);
create index if not exists idx_crosslinks_pair on content_crosslinks (source_id, target_id);

-- Persistent training signal — one row per (source,target) pair. up = super relevant (boost),
-- down = not relevant (suppress in future runs). Survives re-generation.
create table if not exists content_crosslink_feedback (
  source_id  text not null,
  target_id  text not null,
  rating     text not null,          -- up | down
  note       text,
  by_email   text,
  updated_at timestamptz not null default now(),
  primary key (source_id, target_id)
);

alter table content_crosslink_runs enable row level security;
alter table content_crosslinks enable row level security;
alter table content_crosslink_feedback enable row level security;
