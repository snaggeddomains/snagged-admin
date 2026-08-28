#!/usr/bin/env python3
"""Backfill english_words.zipf (word frequency) via wordfreq.

SNAP Research (and any future dictionary walk) wants to enrich "most-common first",
but english_words has no frequency column. This computes wordfreq's zipf_frequency
(0.0 = unknown/rare, ~7 = the commonest words) for every row and writes it to the
new `zipf` column on the NAMING project (snagged-naming-universe).

Prereq SQL (run ONCE on the naming project — scripts/english_words_zipf.sql):
    alter table english_words add column if not exists zipf real;
    create index if not exists idx_english_words_zipf on english_words (zipf desc nulls last);

Env: SUPABASE_NAMING_URL + SUPABASE_NAMING_SERVICE_KEY (same secrets the pipeline uses).
Deps: wordfreq + supabase (both already pipeline dependencies — run under ./.github/actions/setup).

Usage:
    python scripts/backfill_english_zipf.py            # dry-run preview
    python scripts/backfill_english_zipf.py --commit   # write
    python scripts/backfill_english_zipf.py --commit --recompute   # re-score ALL rows (not just NULL)

Idempotent + resumable: by default only rows with zipf IS NULL are processed, keyset-paged
by `word`, so a re-run continues where it left off. `--recompute` re-scores everything.
Upserts on the `word` key with only {word, zipf}, so every other column is preserved.
"""
import argparse
import os
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="Actually write (otherwise dry-run)")
    ap.add_argument("--recompute", action="store_true", help="Re-score ALL rows, not just zipf IS NULL")
    ap.add_argument("--batch", type=int, default=500, help="Rows per page/upsert (default 500)")
    ap.add_argument("--max-rows", type=int, default=0, help="Cap rows processed this run (0 = all)")
    args = ap.parse_args()

    url = os.environ.get("SUPABASE_NAMING_URL")
    key = os.environ.get("SUPABASE_NAMING_SERVICE_KEY")
    if not url or not key:
        print("ERROR: SUPABASE_NAMING_URL / SUPABASE_NAMING_SERVICE_KEY not set", file=sys.stderr)
        return 1

    from wordfreq import zipf_frequency  # lazy — only needed at runtime
    from supabase import create_client

    db = create_client(url, key)

    cursor = ""
    total = 0
    written = 0
    sample: list[tuple[str, float]] = []
    while True:
        q = db.table("english_words").select("word").order("word").limit(args.batch)
        if not args.recompute:
            q = q.is_("zipf", "null")
        if cursor:
            q = q.gt("word", cursor)
        rows = (q.execute().data) or []
        if not rows:
            break
        cursor = rows[-1]["word"]

        payload = []
        for r in rows:
            w = r["word"]
            if not isinstance(w, str) or not w:
                continue
            z = round(float(zipf_frequency(w, "en")), 3)  # 0.0 for unknown words
            payload.append({"word": w, "zipf": z})
            if len(sample) < 12:
                sample.append((w, z))
        total += len(rows)

        if args.commit and payload:
            # Upsert on the natural key — sets only zipf, preserves is_root/pos/definition.
            db.table("english_words").upsert(payload, on_conflict="word").execute()
            written += len(payload)

        if total % 5000 < args.batch:
            print(f"  …{total} processed" + (f" / {written} written" if args.commit else " (dry-run)"))
        if args.max_rows and total >= args.max_rows:
            break

    print(f"\nDONE — processed={total} written={written} commit={args.commit} recompute={args.recompute}")
    if sample:
        print("sample zipf: " + ", ".join(f"{w}={z}" for w, z in sample))
    if not args.commit:
        print("(dry-run — re-run with --commit to write)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
