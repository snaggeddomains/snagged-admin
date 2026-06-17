-- Enable RLS (no policies) on the snagged-zone-index project.
--
-- Supabase flags this project for `rls_disabled_in_public` (same benign alert we
-- already cleared on Master + naming). The app reads the zone DB with the
-- service_role key (ZONE_SUPABASE_SERVICE_KEY), which BYPASSES RLS — so enabling
-- RLS with NO policies closes anon/public read access without breaking anything.
--
-- NOTE: zone_domains is LIST-partitioned, so the partitioned PARENT (relkind 'p')
-- AND every partition (relkind 'r' — zone_domains_legacy/_com/_io and any future
-- per-TLD partitions) must get RLS. `pg_tables` only lists ordinary tables, so we
-- iterate pg_class on relkind IN ('r','p') to catch the parent too. Idempotent and
-- future-proof: re-running after adding a new TLD partition just re-affirms.
--
-- Run in the snagged-zone-index project's SQL editor (ref opzqyeuumusbmvqxehgf).

do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')          -- ordinary + partitioned tables
  loop
    execute format('alter table public.%I enable row level security;', r.relname);
  end loop;
end $$;
