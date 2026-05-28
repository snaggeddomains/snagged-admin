"""Universe sync — read all per-source snapshot.json files, apply the
universe_ingest filter, write today's Parquet partition.

Idempotent: re-running on the same day overwrites the day's partition.
If R2 env vars are set, also uploads. Without them, writes only to a
local path (default: data/universe/observations_<YYYY-MM-DD>.parquet)
which is useful for local development.

Run via:
    pipeline universe-sync                      # use defaults
    pipeline universe-sync --output PATH        # custom local path
    pipeline universe-sync --dry-run            # build but don't write
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from .. import config, state
from ..universe import writer

STATE_NAMESPACE = "universe_sync"
DEFAULT_OUTPUT_DIR = Path("data/universe")


def collect_snapshots(today: str) -> tuple[list[dict], dict[str, int]]:
    """Walk state/<source>/snapshot.json for every wired source and normalize
    each listing into a universe row. Returns (rows, per-source counts)."""
    reg = config.load_registry()
    counts: dict[str, int] = {}
    all_rows: list[dict] = []

    for s in reg.get("sources") or []:
        if not s.get("enabled", True):
            continue
        sid = s["source_id"]
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
        help="collect + filter but skip the actual Parquet/R2 write",
    )
    args = parser.parse_args(argv)

    today = datetime.now(timezone.utc).date().isoformat()
    output = args.output or DEFAULT_OUTPUT_DIR / f"observations_{today}.parquet"

    print(f"Universe sync for {today}")
    print("=" * 50)

    print("[1/3] Collecting per-source snapshots")
    raw_rows, per_source = collect_snapshots(today)
    for sid, n in sorted(per_source.items()):
        print(f"      {sid:<26} {n:>6} rows pass universe filter")
    print(f"      total: {len(raw_rows):,} rows from {len(per_source)} sources")

    print("[2/3] Merging by domain (dedup across sources)")
    merged = writer.merge_observations(raw_rows)
    print(f"      after merge: {len(merged):,} unique domains")

    if args.dry_run:
        print("[3/3] --dry-run: skipping Parquet write")
        r2_target = None
        rows_written = 0
    else:
        print(f"[3/3] Writing Parquet to {output}")
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
        "rows_written": rows_written,
        "output_path": str(output),
        "r2_target": r2_target,
        "per_source_counts": per_source,
        "dry_run": args.dry_run,
    })

    print("DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
