#!/usr/bin/env python3
"""Load additional dictionary words into english_words (NAMING project).

We already hold ~238k words (down to zipf 0), so this ADDS the broader real-dictionary
tranche we were missing — real English words (from the dwyl/english-words 370k list)
that carry SOME real-world usage (wordfreq zipf > 0) and weren't already present, with a
light inflection filter so we don't add plurals/verb-forms of words we already have. The
exact set is precomputed + committed as scripts/data/new_english_words.csv (word,zipf) so
the load is deterministic + reviewable (no CI network / wordfreq dependency).

New rows are inserted with is_root=true so SNAP Research + Expiring .ai actually curate
them (both gate on is_root); pos/definition are left NULL (the WordNet pos backfill can
fill them later — not needed by the dictionary-walk consumers). INSERT ... ON CONFLICT DO
NOTHING (upsert with ignore_duplicates) so an already-present word is NEVER overwritten —
this only adds, never mutates an existing curated row.

Env: SUPABASE_NAMING_URL + SUPABASE_NAMING_SERVICE_KEY (same secrets the pipeline uses).
Deps: supabase (already a pipeline dependency — run under ./.github/actions/setup).

Usage:
    python scripts/load_english_words.py            # dry-run preview (counts only)
    python scripts/load_english_words.py --commit   # insert the new rows
"""
import argparse
import csv
import os
import sys

CSV_PATH = os.path.join(os.path.dirname(__file__), "data", "new_english_words.csv")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="Actually insert (otherwise dry-run)")
    ap.add_argument("--batch", type=int, default=1000, help="Rows per insert (default 1000)")
    ap.add_argument("--csv", default=CSV_PATH, help="Word list CSV (word,zipf)")
    args = ap.parse_args()

    url = os.environ.get("SUPABASE_NAMING_URL")
    key = os.environ.get("SUPABASE_NAMING_SERVICE_KEY")
    if not url or not key:
        print("ERROR: SUPABASE_NAMING_URL + SUPABASE_NAMING_SERVICE_KEY required", file=sys.stderr)
        return 2

    rows = []
    with open(args.csv, newline="") as f:
        for r in csv.DictReader(f):
            w = (r.get("word") or "").strip().lower()
            if not w:
                continue
            z = r.get("zipf")
            try:
                z = float(z) if z not in (None, "") else None
            except ValueError:
                z = None
            rows.append({"word": w, "zipf": z, "is_root": True})
    # de-dup within the file (word is the PK)
    seen, uniq = set(), []
    for r in rows:
        if r["word"] in seen:
            continue
        seen.add(r["word"])
        uniq.append(r)
    rows = uniq
    print(f"words in list: {len(rows)}")

    if not args.commit:
        print("DRY RUN — pass --commit to insert. Sample:", ", ".join(r["word"] for r in rows[:20]))
        return 0

    from supabase import create_client  # type: ignore

    db = create_client(url, key)
    inserted = 0
    for i in range(0, len(rows), args.batch):
        chunk = rows[i : i + args.batch]
        # ON CONFLICT DO NOTHING — never overwrite an existing curated row, only add new.
        db.table("english_words").upsert(chunk, on_conflict="word", ignore_duplicates=True).execute()
        inserted += len(chunk)
        print(f"  upserted {inserted}/{len(rows)}")
    print(f"done — {len(rows)} words processed (existing words skipped via ON CONFLICT DO NOTHING)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
