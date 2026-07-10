-- SNAP Names archive overlay (admin project — SUPABASE_URL / SERVICE_ROLE_KEY).
-- One-time migration. After running: NOTIFY pgrst, 'reload schema';
create table if not exists snap_names_archive (
  domain text primary key,
  archived_by text,
  archived_at timestamptz not null default now()
);
alter table snap_names_archive enable row level security; -- service key bypasses RLS
