-- Run AFTER the bulk \copy completes. On a .com-sized table (~165M rows) the GIN
-- build is heavy — bump maintenance_work_mem first so it doesn't crawl.
set maintenance_work_mem = '2GB';

-- Reverse lookups (nameserver → domains): GIN supports @> (contains-all = AND)
-- and && (overlaps = OR) on the array.
create index if not exists idx_zone_domains_ns_gin on zone_domains using gin (nameservers);

-- Optional TLD scoping.
create index if not exists idx_zone_domains_tld on zone_domains (tld);

analyze zone_domains;
