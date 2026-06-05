-- Migrate the single zone_domains table → TLD-partitioned (LIST by tld).
-- Run on the snagged-zone-index project. The app queries the parent `zone_domains`
-- transparently — no code change. Each partition gets its OWN domain btree AND
-- nameservers GIN (the partitioned parent has no PK) so .com can build/reload in
-- isolation without touching the other TLDs, and a `?tld=` query prunes to one
-- partition.
--
-- ⚠️ HISTORICAL NOTE — what actually ran in prod (2026-06): the copy-based
-- migration in steps 2-4 below was ABANDONED. The `insert ... select` doubled the
-- data + WAL on the small disk → PANIC "No space left on device" → crash recovery.
-- We instead did a NO-COPY migration: rename zone_domains → zone_domains_legacy and
-- ATTACH it as the DEFAULT partition (zero copy). So the LIVE layout is:
--   zone_domains_legacy  -- DEFAULT partition, holds the original 5 (dev/org/xyz/ai/co)
--   zone_domains_com     -- .com (~163M), its own partition + 2 indexes
--   zone_domains_io      -- .io  (~1.12M), its own partition + 2 indexes
-- The steps below are kept for reference; the ADD-A-TLD runbook at the bottom is
-- the live procedure. To split a legacy TLD into its own partition later, detach
-- the default, create the explicit partition, move its rows, re-attach the default.
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
-- ── ADD-A-TLD RUNBOOK (the live procedure) ──────────────────────────────────
-- Source formats: CZDS zone-master (space-delimited NS records — .com/.org/.dev/
-- .xyz) vs Domains-Monitor "detailed" (semicolon CSV "domain";"ns1,ns2";… —
-- .ai/.co/.io). load_ns.sh parses the semicolon format; .com used a zone-file
-- parser streamed through the droplet. Small TLDs (≤ a few M rows) load straight
-- from a local psql on Micro; .com needs XL + the droplet stream.
--
-- 1) create the partition FIRST (COPY into the parent routes here; must exist):
--      create table zone_domains_<tld> partition of zone_domains for values in ('<tld>');
-- 2) load (partition is index-free → fast, no OOM):
--      bash load_ns.sh <tld> <file>        # semicolon format
--      -- or the inline parser; or stream via the droplet for .com
-- 3) build BOTH indexes + analyze (Micro maintenance_work_mem='256MB';
--    XL '2GB' for .com):
--      set statement_timeout=0; set maintenance_work_mem='256MB';
--      create index idx_zone_<tld>_ns_gin on zone_domains_<tld> using gin(nameservers);
--      create index idx_zone_<tld>_domain on zone_domains_<tld> (domain);
--      analyze zone_domains_<tld>;
--
-- Worked example — .io (2026-06, 1,123,938 rows, ran on Micro):
--   create table zone_domains_io partition of zone_domains for values in ('io');
--   unzip -p io.zip | <inline semicolon parser> | psql \copy zone_domains FROM STDIN ...
--   create index idx_zone_io_ns_gin on zone_domains_io using gin(nameservers);
--   create index idx_zone_io_domain on zone_domains_io (domain);
--   analyze zone_domains_io;
--
-- Re-load / refresh a TLD: truncate its partition (drop indexes first if large),
-- reload, rebuild indexes — keeps the other partitions untouched.
