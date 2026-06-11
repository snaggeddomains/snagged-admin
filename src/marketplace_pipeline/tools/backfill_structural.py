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

import argparse
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
    # Score on the effective zipf (recovers two-word names; raw zipf_score stays raw).
    qzipf = univ.quality_zipf(sld, zipf)
    quality = round(scoring.quality_score(qzipf, weight), 2) if qzipf else None
    best_price = r.get("best_price")
    bp = float(best_price) if best_price is not None else None
    deal = (
        int(round(scoring.deal_score(qzipf, bp, weight)))
        if qzipf and bp is not None and bp > 0
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


def _run_universe(rescore: bool = False) -> int:
    """Default: fill structural fields on rows that never got them (num_syllables
    IS NULL) — idempotent + resumable.

    --rescore: recompute the SCORES on EVERY row using the current formula. Needed
    after a scoring change (e.g. the 2026-06 quality_zipf fix that gave two-word
    names + .xyz/.dev a real quality_score instead of 0.0) so the already-stored
    corpus matches new ingest. Touches all ~rows, so it's the long one — dispatch it
    on the GH runner.
    """
    client = _client_or_none()
    if client is None:
        print("backfill-structural: SUPABASE_NAMING_URL / SUPABASE_NAMING_SERVICE_KEY not set — skipping.")
        return 0

    last_domain = ""
    total = 0
    while True:
        q = client.table("name_universe").select(
            "domain, sld, tld, sld_length, sources, best_price, "
            "best_price_source, first_seen, last_seen, source_tier"
        )
        # Default backfill is gated to never-processed rows; --rescore walks all.
        if not rescore:
            q = q.is_("num_syllables", "null")
        resp = q.gt("domain", last_domain).order("domain").limit(SELECT_BATCH).execute()
        rows = resp.data or []
        if not rows:
            break
        client.table("name_universe").upsert(
            [_row_update(r) for r in rows], on_conflict="domain"
        ).execute()
        total += len(rows)
        last_domain = rows[-1]["domain"]
        verb = "rescored" if rescore else "backfilled"
        print(f"  {verb} {total:,} (through {last_domain})", flush=True)

    verb = "rescored" if rescore else "backfilled"
    print(f"DONE — {verb} {total:,} rows.")
    return 0


def _master_quality(domain: str, tld: str | None) -> float | None:
    """quality_score for a Master Domain List row, using the SAME formula as
    name_universe ingest: round(zipf_frequency(sld,'en') * tld_weight(tld), 2).

    Master has no `sld` column, so derive it by stripping the TLD off the domain.
    Only clean single-label, alphabetic SLDs are scoreable (matches universe,
    which returns NULL for non-alpha SLDs); multi-label hosts (a.b.com) → None.
    An unknown TLD weighs 0.0, so the score is 0.0 — same as universe.
    """
    domain = (domain or "").strip().lower()
    tld_bare = (tld or "").strip().lower().lstrip(".")
    if tld_bare and domain.endswith("." + tld_bare):
        sld = domain[: -(len(tld_bare) + 1)]
    else:
        sld, _, _ = domain.partition(".")
    if not sld or "." in sld or not sld.isalpha():
        return None
    qzipf = univ.quality_zipf(sld, float(flt.freq(sld)))
    weight = scoring.tld_weight(tld_bare)
    return round(scoring.quality_score(qzipf, weight), 2)


def _run_master(args: argparse.Namespace) -> int:
    """Backfill ONLY quality_score on the Master Domain List (it's imported
    externally and never got the structural score). Leaves Master's curated
    number_of_words / is_single_word / dictionary_word columns untouched — we
    only add the score the naming exercise ranks on. Dry-run unless --commit.

    Requires the column first (run in the masterlist project):
        alter table "Master Domain List" add column if not exists quality_score double precision;
        create index if not exists idx_master_quality
          on "Master Domain List" (quality_score desc nulls last);
    """
    from .enrich import _master_client

    client = _master_client()
    if client is None:
        print("backfill-structural: MASTERLIST_SUPABASE_URL / MASTERLIST_SUPABASE_SECRET_KEY not set — skipping.")
        return 0

    last_domain = ""
    total = filled = nulls = 0
    while True:
        if args.max_rows is not None and total >= args.max_rows:
            break
        limit = SELECT_BATCH
        if args.max_rows is not None:
            limit = min(SELECT_BATCH, args.max_rows - total)
        resp = (
            client.table("Master Domain List")
            .select("domain, tld, quality_score")
            .is_("quality_score", "null")
            .gt("domain", last_domain)
            .order("domain")
            .limit(limit)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            break
        payload = []
        for r in rows:
            q = _master_quality(r.get("domain"), r.get("tld"))
            if q is None:
                nulls += 1
            else:
                filled += 1
            payload.append({"domain": r["domain"], "quality_score": q})
        if args.commit:
            client.table("Master Domain List").upsert(payload, on_conflict="domain").execute()
        total += len(rows)
        last_domain = rows[-1]["domain"]
        verb = "wrote" if args.commit else "previewed"
        print(f"  {verb} {total:,} (scored {filled:,}, null {nulls:,}; through {last_domain})", flush=True)

    mode = "DONE" if args.commit else "DRY-RUN"
    print(f"{mode} — processed {total:,} rows; {filled:,} got a quality_score, "
          f"{nulls:,} stayed null (non-alpha / multi-label SLD).")
    if not args.commit:
        print("  (dry-run: no writes. Re-run with --commit to persist.)")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pipeline backfill-structural")
    ap.add_argument("--target", choices=["universe", "master"], default="universe",
                    help="universe = full structural backfill (default); "
                         "master = quality_score only")
    ap.add_argument("--commit", action="store_true",
                    help="master: actually write (default dry-run). universe always writes.")
    ap.add_argument("--max-rows", type=int, default=None, help="master: cap rows processed")
    ap.add_argument("--rescore", action="store_true",
                    help="universe: recompute scores on EVERY row (not just missing) — "
                         "use after a scoring-formula change to refresh the stored corpus")
    args = ap.parse_args(argv)

    if args.target == "master":
        return _run_master(args)
    return _run_universe(rescore=args.rescore)


if __name__ == "__main__":
    sys.exit(main())
