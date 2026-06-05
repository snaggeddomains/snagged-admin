-- Migrate the single zone_domains table → TLD-partitioned (LIST by tld).
-- Run on the snagged-zone-index project. Postgres can't convert a table to
-- partitioned in place, so we recreate + copy (brief downtime for the tool while
-- this runs). The app queries the parent `zone_domains` transparently — no code
-- change. Each partition gets its OWN GIN so .com can build/reload in isolation
-- without touching the other TLDs, and a `?tld=` query prunes to one partition.
--
-- Compute: the migration itself is fine on Micro (only ~22.5M rows; use
-- maintenance_work_mem='256MB'). Bump to XL only for the eventual .com load.

set statement_timeout = 0;
set maintenance_work_mem = '256MB';   -- '2GB' if running on XL

-- 1) move the current table + index aside
alter table zone_domains rename to zone_domains_old;
alter index idx_zone_domains_ns_gin rename to idx_zone_domains_ns_gin_old;

-- 2) partitioned parent (PK must include the partition key tld)
create table zone_domains (
  domain      text not null,
  tld         text not null,
  nameservers text[] not null,
  primary key (domain, tld)
) partition by list (tld);
alter table zone_domains enable row level security;

-- 3) one partition per TLD (+ an empty com partition for later)
create table zone_domains_ai  partition of zone_domains for values in ('ai');
create table zone_domains_co  partition of zone_domains for values in ('co');
create table zone_domains_dev partition of zone_domains for values in ('dev');
create table zone_domains_org partition of zone_domains for values in ('org');
create table zone_domains_xyz partition of zone_domains for values in ('xyz');
create table zone_domains_com partition of zone_domains for values in ('com');

-- 4) copy data (routes to the right partition by tld)
insert into zone_domains (domain, tld, nameservers)
  select domain, tld, nameservers from zone_domains_old;

-- 5) per-partition GIN on the populated partitions (com is empty → index after load)
create index on zone_domains_ai  using gin (nameservers);
create index on zone_domains_co  using gin (nameservers);
create index on zone_domains_dev using gin (nameservers);
create index on zone_domains_org using gin (nameservers);
create index on zone_domains_xyz using gin (nameservers);
analyze zone_domains;

-- 6) verify, then drop the old table
select tld, count(*) from zone_domains group by tld order by tld;
-- once counts match:
--   drop table zone_domains_old;

-- ── Loading .com later (on XL) ──────────────────────────────────────────────
-- load_ns.sh is unchanged — it copies into zone_domains, which routes com rows
-- into the empty, index-free zone_domains_com (fast, no OOM). Then build BOTH
-- indexes on the partition (the partitioned parent has no PK, so each new
-- partition needs its own domain btree AND the nameservers GIN):
--   set statement_timeout=0; set maintenance_work_mem='2GB';
--   create index idx_zone_com_ns_gin on zone_domains_com using gin(nameservers);
--   create index idx_zone_com_domain on zone_domains_com (domain);  -- REQUIRED:
--       without it, domain lookups seq-scan 163M rows -> statement timeout
--   analyze zone_domains_com;
-- ...then scale compute back to Micro.
-- NOTE: lookupDomain() in the research app filters by tld so the planner prunes
-- to the one partition; every partition therefore needs its own domain index
-- (the legacy default partition keeps the original PK; new ones need it added).
--
-- To add any future TLD: create its partition first, e.g.
--   create table zone_domains_io partition of zone_domains for values in ('io');
-- then bash load_ns.sh io <file>, then build its GIN.
