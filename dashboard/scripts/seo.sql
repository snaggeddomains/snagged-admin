-- SEO report — high-intent keyword rank tracking + weekly snapshots + action loop.
-- Run once on the MAIN project (SUPABASE_URL). RLS enabled (service key bypasses).

-- The curated list of high-intent / money terms we actively work to rank for.
create table if not exists seo_target_keywords (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,
  target_url text,                    -- the page that should rank for it
  intent text,                        -- transactional | commercial | informational
  priority smallint default 2,        -- 1 = highest
  volume integer,                     -- last-known Ahrefs monthly search volume (cache)
  notes text,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists idx_seo_kw_unique on seo_target_keywords (lower(keyword));

-- Weekly per-keyword metrics (GSC). scope='target' = the curated list (deltas + status);
-- scope='query' = the week's top GSC queries (powers the biggest-movers view).
create table if not exists seo_keyword_snapshots (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  scope text not null default 'target',
  keyword text not null,
  position numeric,                   -- impression-weighted avg GSC position (lower = better)
  impressions integer default 0,
  clicks integer default 0,
  ctr numeric,
  volume integer,                     -- Ahrefs volume snapshot (target scope)
  ahrefs_position numeric,            -- our Ahrefs best position (fallback when GSC has no impressions)
  competitor_position numeric,        -- MediaOptions position for the term (head-to-head)
  top_url text,
  created_at timestamptz default now()
);
create unique index if not exists idx_seo_snap_unique on seo_keyword_snapshots (week_start, scope, lower(keyword));
create index if not exists idx_seo_snap_week on seo_keyword_snapshots (scope, week_start desc);

-- The active weekly to-do / next-steps list, tied optionally to a keyword/page.
create table if not exists seo_actions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  detail text,                          -- one-line subtitle
  playbook text,                        -- long-form drill-down (markdown); see scripts/seo_playbooks.sql
  keyword text,
  target_url text,
  status text not null default 'todo',  -- todo | doing | done
  priority smallint default 2,
  owner_email text,
  created_by text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  done_at timestamptz
);
create index if not exists idx_seo_actions_status on seo_actions (status, priority, updated_at desc);

do $$ declare r text; begin
  for r in select unnest(array['seo_target_keywords','seo_keyword_snapshots','seo_actions']) loop
    execute format('alter table public.%I enable row level security;', r);
  end loop;
end $$;

-- Seed the money terms from the SEO action plan (idempotent).
insert into seo_target_keywords (keyword, target_url, intent, priority) values
  ('domain broker',          'https://www.snagged.com/domain-broker',     'commercial',    1),
  ('domain brokers',         'https://www.snagged.com/domain-broker',     'commercial',    1),
  ('best domain broker',     'https://www.snagged.com/domain-broker',     'commercial',    1),
  ('domain name broker',     'https://www.snagged.com/domain-broker',     'commercial',    2),
  ('premium domain broker',  'https://www.snagged.com/domain-broker',     'commercial',    2),
  ('domain acquisition',     'https://www.snagged.com/buy-a-domain',      'commercial',    1),
  ('buy a domain',           'https://www.snagged.com/buy-a-domain',      'transactional', 2),
  ('sell a domain',          'https://www.snagged.com/sell-your-domain',  'transactional', 1),
  ('sell my domain',         'https://www.snagged.com/sell-your-domain',  'transactional', 2),
  ('domain appraisal',       'https://www.snagged.com/domain-appraisal',  'commercial',    1),
  ('domain value',           'https://www.snagged.com/domain-appraisal',  'commercial',    2),
  ('what is my domain worth', 'https://www.snagged.com/domain-appraisal', 'informational', 3)
on conflict (lower(keyword)) do nothing;

-- Seed the top action items from the plan.
insert into seo_actions (title, detail, keyword, target_url, priority) values
  ('Build /domain-broker page', 'The #1 prize (~2K combined vol). Slug + title + H1 all matching "domain broker". Service + FAQ schema, sitemap, internal-linked.', 'domain broker', 'https://www.snagged.com/domain-broker', 1),
  ('Build /sell-your-domain page', 'Dedicated commercial page for "sell a domain" / "sell my domain".', 'sell a domain', 'https://www.snagged.com/sell-your-domain', 1),
  ('Build /buy-a-domain (acquisition) page', 'Target "domain acquisition" / "buy a domain".', 'domain acquisition', 'https://www.snagged.com/buy-a-domain', 1),
  ('Ship /domain-appraisal free-tool landing page', 'We have an actual appraisal tool — a tool page out-ranks MediaOptions'' text post for "domain value".', 'domain appraisal', 'https://www.snagged.com/domain-appraisal', 1),
  ('Internal-link money pages from top 5 blog posts', 'Add contextual links FROM nissan/geocities/gmail/casper posts TO the new commercial pages with "domain broker"/"sell your domain" anchors. Fastest lever, no new authority needed.', null, null, 2),
  ('Build /brokered-domains case-study hub', 'Turn each closed deal into a page optimized for "<name>.com" that internally links "domain broker".', null, null, 2)
on conflict do nothing;
