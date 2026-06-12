-- Backfill rescore RPC (naming project: snagged-naming-universe).
--
-- The structural/score backfill recomputes quality_score (INDEXED), which forces
-- a non-HOT update that re-inserts every row into ALL indexes — including the two
-- GIN indexes (sources, keywords) — even though those values don't change. Doing
-- that one row per HTTP request (PostgREST .update()) is far too slow for the
-- ~6-10M-row corpus (the round-trips dominate). This function lets the backfill
-- send a whole batch (jsonb array of ~1000 rows) in ONE call and apply it with a
-- single set-based UPDATE ... FROM — ~1000x fewer round-trips. The per-row index
-- maintenance still happens server-side, but batched (and WAL-batched), which is
-- the only REST-reachable way to finish in a reasonable window.
--
-- Keyed on `domain`. Writes ONLY the recomputed columns; never touches the GIN
-- array columns or NOT-NULL identity columns (so no insert-tuple validation, no
-- array-index churn beyond the unavoidable non-HOT re-link). Returns rows updated.
--
-- Run once on the naming project. Re-runnable (create or replace).

create or replace function public.backfill_universe_rescore(rows jsonb)
returns integer
language plpgsql
as $$
declare n integer;
begin
  -- Give each batch room; a 1000-row non-HOT update with GIN re-links can exceed
  -- the default statement_timeout.
  perform set_config('statement_timeout', '180000', true);

  update name_universe t set
    zipf_score         = (r->>'zipf_score')::double precision,
    num_words          = (r->>'num_words')::integer,
    num_syllables      = (r->>'num_syllables')::integer,
    is_dictionary_word = (r->>'is_dictionary_word')::boolean,
    quality_score      = (r->>'quality_score')::double precision,
    deal_score         = (r->>'deal_score')::integer,
    part_of_speech     = coalesce(
      (select array_agg(x) from jsonb_array_elements_text(r->'part_of_speech') x),
      '{}'::text[])
  from jsonb_array_elements(rows) as r
  where t.domain = r->>'domain';

  get diagnostics n = row_count;
  return n;
end
$$;

grant execute on function public.backfill_universe_rescore(jsonb) to service_role;
