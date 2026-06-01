"""Backfill structural enrichment on name_universe rows that are missing it.

Rows ingested outside the normal pipeline path (e.g. a direct SQL/CSV load like
the BrandBucket import) land without the wordfreq-derived structural fields. This
walks every row where `num_syllables IS NULL` and fills num_words, num_syllables,
is_dictionary_word, zipf_score, quality_score, deal_score using the SAME method as
ingest (filters.universe.classify_dict_word / count_syllables, filters.standard.freq,
scoring.*), so the search's single-word/dictionary filters behave identically across
every row.

Idempotent + resumable: num_syllables is set (>=1) on every processed row, so a
re-run only touches still-unprocessed rows. The direct PostgREST upsert writes only
the structural + identity columns — LLM-enrichment columns (category/emotions/
keywords/industries) and embedding are left untouched.

Speed tip: a partial index makes the scan touch only unprocessed rows —
    create index if not exists idx_universe_needs_structural
      on name_universe (domain) where num_syllables is null;
"""
from __future__ import annotations

import sys

from .. import scoring
from ..filters import standard as flt
from ..filters import universe as univ
from ..universe.supabase_writer import _client_or_none

SELECT_BATCH = 1000


def _row_update(r: dict) -> dict:
    sld = (r.get("sld") or "")
    tld = r.get("tld") or ""
    zipf = float(flt.freq(sld)) if sld.isalpha() else None
    num_words = univ.classify_dict_word(sld)
    weight = scoring.tld_weight(tld)
    quality = round(scoring.quality_score(zipf, weight), 2) if zipf is not None else None
    best_price = r.get("best_price")
    bp = float(best_price) if best_price is not None else None
    deal = (
        int(round(scoring.deal_score(zipf, bp, weight)))
        if zipf is not None and bp is not None and bp > 0
        else None
    )
    return {
        # identity / NOT NULL columns — passed back unchanged
        "domain": r["domain"],
        "sld": sld,
        "tld": tld,
        "sld_length": r["sld_length"],
        "sources": r.get("sources") or [],
        "best_price": best_price,
        "best_price_source": r.get("best_price_source"),
        "source_tier": r.get("source_tier"),
        "first_seen": r["first_seen"],
        "last_seen": r["last_seen"],
        # structural fields being filled (same method as ingest)
        "zipf_score": zipf,
        "num_words": num_words,
        "num_syllables": univ.count_syllables(sld),
        "is_dictionary_word": (num_words == 1) if num_words is not None else None,
        "quality_score": quality,
        "deal_score": deal,
    }


def main(argv: list[str] | None = None) -> int:
    client = _client_or_none()
    if client is None:
        print("backfill-structural: SUPABASE_NAMING_URL / SUPABASE_NAMING_SERVICE_KEY not set — skipping.")
        return 0

    last_domain = ""
    total = 0
    while True:
        resp = (
            client.table("name_universe")
            .select(
                "domain, sld, tld, sld_length, sources, best_price, "
                "best_price_source, first_seen, last_seen, source_tier"
            )
            .is_("num_syllables", "null")
            .gt("domain", last_domain)
            .order("domain")
            .limit(SELECT_BATCH)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            break
        client.table("name_universe").upsert(
            [_row_update(r) for r in rows], on_conflict="domain"
        ).execute()
        total += len(rows)
        last_domain = rows[-1]["domain"]
        print(f"  backfilled {total:,} (through {last_domain})", flush=True)

    print(f"DONE — backfilled {total:,} rows.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
