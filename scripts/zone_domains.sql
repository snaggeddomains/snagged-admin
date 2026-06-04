-- Zone-file domain → nameserver index. Powers research → Nameserver Search
-- (domain → its NS, and reverse: NS pair → sibling domains for ownership clues).
-- Run on the NAMING project (snagged-naming-universe).
--
-- Order matters for a multi-GB load: create the table (NO indexes), bulk-load,
-- THEN build the GIN index (scripts/zone_domains_indexes.sql) — building the
-- index once at the end is far faster than maintaining it per-row during COPY.
--
-- One row per domain; the NS set lives in an array so the core query is a single
-- array-containment:  nameservers @> '{ns1,ns2}'  (AND)  /  &&  (OR).

create table if not exists zone_domains (
  domain      text primary key,   -- full domain, lowercased (e.g. "pizza.com")
  tld         text not null,      -- bare tld (e.g. "com")
  nameservers text[] not null     -- lowercased NS hostnames, no trailing dot
);

-- RLS on, no policies → service key only (matches the other naming tables).
alter table zone_domains enable row level security;
