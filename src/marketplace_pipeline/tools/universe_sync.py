"""Universe sync — read all per-source snapshot.json files, apply the
universe_ingest filter, upsert into Supabase, and (optionally) write a
Parquet partition for historical archive.

Order of operations:
  1. Walk state/<source>/snapshot.json and apply universe filter
  2. Merge per-source rows so each domain is one row with a sources[]
     and per-source price map
  3. Upsert into the Supabase `name_universe` table via the
     `upsert_universe_rows` RPC (preserves first_seen, refreshes
     last_seen + sources + best_price for each domain seen today)
  4. Write today's Parquet partition for historical archive (Tier 3
     R2 storage). Skipped on --dry-run.

Idempotent: re-running on the same day is safe — the Supabase upsert
overwrites the day's snapshot fields cleanly, and the Parquet write
overwrites the day's partition.

Run via:
    pipeline universe-sync                      # full run
    pipeline universe-sync --output PATH        # custom local path
    pipeline universe-sync --dry-run            # collect + merge only,
                                                # skip Supabase + Parquet
    pipeline universe-sync --skip-supabase      # write Parquet only
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from .. import config, state
from ..universe import supabase_writer, writer

STATE_NAMESPACE = "universe_sync"
DEFAULT_OUTPUT_DIR = Path("data/universe")


def collect_snapshots(today: str) -> tuple[list[dict], dict[str, int]]:
    """Walk every wired source's snapshot file and normalize each listing
    into a universe row. Returns (rows, per-source counts).

    Prefers `universe_snapshot.json` (broader, structural+dict-word filter
    applied at source-write time, contains everything universe should
    consider) when present. Falls back to `snapshot.json` (which is the
    SNAP-filtered output used for Slack/Sheets) for sources that haven't
    been migrated to write a separate universe snapshot yet."""
    reg = config.load_registry()
    counts: dict[str, int] = {}
    all_rows: list[dict] = []

    for s in reg.get("sources") or []:
        if not s.get("enabled", True):
            continue
        sid = s["source_id"]
        # Prefer the broader universe snapshot when the source writes one.
        snapshot = state.read_json(sid, "universe_snapshot.json", default=None)
        if snapshot is None:
            snapshot = state.read_json(sid, "snapshot.json", default=None)
        if not snapshot:
            continue
        # snapshot might be a list of dicts (listings) or a dict with 'items'.
        listings = snapshot if isinstance(snapshot, list) else snapshot.get("items", [])
        if not isinstance(listings, list):
            continue
        kept = 0
        for L in listings:
            if not isinstance(L, dict):
                continue
            row = writer.normalize_listing(sid, L, observed_date=today)
            if row is not None:
                all_rows.append(row)
                kept += 1
        counts[sid] = kept

    return all_rows, counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipeline universe-sync")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="local Parquet output path (default: "
             "data/universe/observations_<YYYY-MM-DD>.parquet)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="collect + filter but skip the Supabase upsert and Parquet write",
    )
    parser.add_argument(
        "--skip-supabase",
        action="store_true",
        help="don't upsert to Supabase (Parquet only)",
    )
    args = parser.parse_args(argv)

    today = datetime.now(timezone.utc).date().isoformat()
    output = args.output or DEFAULT_OUTPUT_DIR / f"observations_{today}.parquet"

    print(f"Universe sync for {today}")
    print("=" * 50)

    print("[1/4] Collecting per-source snapshots")
    raw_rows, per_source = collect_snapshots(today)
    for sid, n in sorted(per_source.items()):
        print(f"      {sid:<26} {n:>6} rows pass universe filter")
    print(f"      total: {len(raw_rows):,} rows from {len(per_source)} sources")

    print("[2/4] Merging by domain (dedup across sources)")
    merged = writer.merge_observations(raw_rows)
    print(f"      after merge: {len(merged):,} unique domains")

    if args.dry_run:
        print("[3/4] --dry-run: skipping Supabase upsert")
        print("[4/4] --dry-run: skipping Parquet write")
        upsert_stats = {"status": "skipped", "reason": "dry-run", "rows_sent": 0, "batches": 0}
        rows_written = 0
        r2_target = None
    else:
        if args.skip_supabase:
            print("[3/4] --skip-supabase: skipping Supabase upsert")
            upsert_stats = {"status": "skipped", "reason": "--skip-supabase", "rows_sent": 0, "batches": 0}
        else:
            print("[3/4] Upserting into Supabase name_universe")
            upsert_stats = supabase_writer.upsert(merged)
            if upsert_stats["status"] == "ok":
                print(f"      upserted {upsert_stats['rows_sent']:,} rows in "
                      f"{upsert_stats['batches']} batch(es)")
            else:
                print(f"      skipped: {upsert_stats.get('reason')}")

        print(f"[4/4] Writing Parquet to {output}")
        rows_written = writer.write_parquet(merged, output)
        print(f"      wrote {rows_written:,} rows")
        r2_target = writer.upload_to_r2(output, observed_date=today)
        if r2_target:
            print(f"      uploaded to {r2_target}")
        else:
            print("      R2 not configured (R2_ACCESS_KEY_ID etc.) — local only")

    state.write_json(STATE_NAMESPACE, "run_status.json", {
        "source": STATE_NAMESPACE,
        "label": "Universe sync",
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "observed_date": today,
        "raw_rows": len(raw_rows),
        "merged_rows": len(merged),
        "supabase_status": upsert_stats["status"],
        "supabase_rows_sent": upsert_stats["rows_sent"],
        "rows_written": rows_written,
        "output_path": str(output),
        "r2_target": r2_target,
        "per_source_counts": per_source,
        "dry_run": args.dry_run,
        "new_count": upsert_stats["rows_sent"],
    })

    print("DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
