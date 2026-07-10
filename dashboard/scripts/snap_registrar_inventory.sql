-- SNAP Names registrar-account inventory snapshot + audit-hide overlay.
-- Run on the ADMIN project (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY), where the
-- other snap_names_* tables live. Service key bypasses RLS.

-- Single-row cached snapshot of every registrar account's domain inventory.
create table if not exists snap_registrar_inventory (
  id text primary key default 'current',
  built_at timestamptz not null default now(),
  built_by text,
  accounts jsonb not null default '[]'::jsonb, -- per-account status (provider, ok, count, ...)
  owned jsonb not null default '{}'::jsonb      -- domain -> { provider, label, account }
);
alter table snap_registrar_inventory enable row level security; -- service key bypasses

-- Per-domain "resolve from the reconciliation audit" flag + reason tag
-- (untracked / missing buckets). A row here is dismissed from the audit; the tag
-- records WHY (Sold / Let expire / Personal / …).
create table if not exists snap_inventory_hidden (
  domain text primary key,
  tag text,
  hidden_by text,
  hidden_at timestamptz not null default now()
);
alter table snap_inventory_hidden add column if not exists tag text; -- if table pre-existed
alter table snap_inventory_hidden enable row level security; -- service key bypasses

-- Manually-added SNAP names (domains we own in an account but aren't on the sheets).
-- Merged into the report so they show as regular rows without editing the sheets.
create table if not exists snap_names_manual (
  domain text primary key,
  source text,   -- Berserk | SNAP | Rob (which list bucket it belongs to)
  owner text,
  added_by text,
  added_at timestamptz not null default now()
);
alter table snap_names_manual enable row level security; -- service key bypasses
