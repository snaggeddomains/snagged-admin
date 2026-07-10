-- SNAP Names registrar-write audit log (admin project — SUPABASE_URL / SERVICE_ROLE_KEY).
-- One-time migration. After running: NOTIFY pgrst, 'reload schema';
create table if not exists snap_names_writes (
  id bigint generated always as identity primary key,
  domain text not null,
  provider text,
  account text,
  action text not null,           -- 'nameservers' | 'dns'
  from_ns text[],
  to_ns text[],
  record jsonb,
  ok boolean not null,
  error text,
  changed_by text,
  created_at timestamptz not null default now()
);
create index if not exists idx_snap_writes_domain on snap_names_writes (domain, created_at desc);
alter table snap_names_writes enable row level security; -- service key bypasses
