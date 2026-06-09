-- TLD facet counts for a nameserver match — powers the post-results "filter to a
-- TLD" bar in Nameserver Search (research app: lib/nameserver/query.js nsTldFacets
-- → api/nameserver.js `ns` mode → the .ns-tldbar chips in public/app.js).
--
-- Run ONCE on the snagged-zone-index project (the zone DB). Called by the app via
-- the service key: rpc('ns_tld_counts', { p_ns, p_match }).
--
-- Read-only group-by-count. The internal 5s statement_timeout keeps a huge
-- shared-host match (e.g. a generic parking NS with millions of rows) from
-- hanging — it errors, and the app degrades gracefully to "no facet bar" while
-- the result list still renders. For a SELECTIVE nameserver (the ownership-signal
-- case) the @>/&& match is small, so the count is exact and fast.

create or replace function ns_tld_counts(p_ns text[], p_match text default 'all')
returns table(tld text, n bigint)
language plpgsql
volatile  -- must be volatile: a STABLE/IMMUTABLE function can't run `SET LOCAL`
as $$
begin
  set local statement_timeout = '5s';
  if p_match = 'any' then
    return query
      select z.tld, count(*)::bigint
      from zone_domains z
      where z.nameservers && p_ns
      group by z.tld
      order by count(*) desc;
  else
    return query
      select z.tld, count(*)::bigint
      from zone_domains z
      where z.nameservers @> p_ns
      group by z.tld
      order by count(*) desc;
  end if;
end
$$;
