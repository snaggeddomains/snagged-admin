-- Email Health (Reports → Email Health) — cached MXToolbox deliverability checks per sending
-- domain. The report page reads this cache; a Refresh button + a daily cron re-run the checks
-- (each costs MXToolbox DNS/network quota). Run once on the MAIN project. RLS on (service key
-- bypasses).
create table if not exists email_health_checks (
  domain      text primary key,
  grade       text,                  -- A / B / F / ?
  failing     text[] default '{}',   -- check keys currently failing (the alert set)
  report      jsonb not null,        -- the full DomainHealth (checks + values + issues)
  checked_at  timestamptz not null default now()
);
alter table email_health_checks enable row level security;
