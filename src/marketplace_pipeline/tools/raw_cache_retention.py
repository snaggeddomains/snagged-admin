"""Pipeline Raw Cache retention — prune date subfolders older than N days.

Tier 2 cache layout in the Shared Drive:
  Pipeline Raw Cache/
    <source_id>/
      <YYYY-MM-DD>/
        <filename>

This tool walks the cache root, finds date subfolders older than the
retention horizon (default 7 days, from sources.yaml
storage.pipeline_raw_cache_retention_days), and moves them to trash via
the Drive API. Trashing the date folder takes its files with it.

Generalized from legacy/openclaw/scripts/atom_drive_retention.py — that
script targeted only the Atom Dumps folder; this one covers the unified
Pipeline Raw Cache where every URL/API source caches.

Run via:
    pipeline raw-cache-retention                # use registry default
    pipeline raw-cache-retention --days 14      # custom horizon
    pipeline raw-cache-retention --dry-run      # print what would be trashed
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime, timedelta, timezone

from .. import config, drive_cache, state

DATE_FOLDER_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATE_NAMESPACE = "raw_cache_retention"


def _drive_service():
    return drive_cache._drive_service()


def _trash_folder(service, folder_id: str) -> None:
    """Move a Drive folder (and its contents) to trash."""
    service.files().update(
        fileId=folder_id,
        body={"trashed": True},
        supportsAllDrives=True,
    ).execute()


def _list_subfolders(service, parent_id: str) -> list[dict]:
    """List folder children only (skip files)."""
    res = service.files().list(
        q=(
            f"'{parent_id}' in parents and trashed=false "
            f"and mimeType='application/vnd.google-apps.folder'"
        ),
        fields="files(id,name,modifiedTime)",
        pageSize=500,
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()
    return res.get("files", [])


def prune(
    *,
    retention_days: int,
    dry_run: bool = False,
    service=None,
) -> dict:
    """Walk the Pipeline Raw Cache root and trash date subfolders older than
    the cutoff. Returns counts for the run.
    """
    reg = config.load_registry()
    root = (reg.get("storage") or {}).get("pipeline_raw_cache_folder_id")
    if not root:
        raise RuntimeError(
            "pipeline_raw_cache_folder_id is not set in sources.yaml — "
            "nothing to prune."
        )
    svc = service or _drive_service()
    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=retention_days))

    source_folders = _list_subfolders(svc, root)
    scanned = 0
    trashed: list[dict] = []
    kept = 0

    for src_folder in source_folders:
        date_folders = _list_subfolders(svc, src_folder["id"])
        for date_folder in date_folders:
            scanned += 1
            name = date_folder["name"]
            if not DATE_FOLDER_RE.match(name):
                # Skip oddly-named folders; leave them alone
                kept += 1
                continue
            try:
                folder_date = datetime.strptime(name, "%Y-%m-%d").date()
            except ValueError:
                kept += 1
                continue
            if folder_date < cutoff:
                if dry_run:
                    print(f"  [dry-run] would trash {src_folder['name']}/{name}")
                else:
                    print(f"  trashing {src_folder['name']}/{name}")
                    _trash_folder(svc, date_folder["id"])
                trashed.append({
                    "source": src_folder["name"],
                    "date": name,
                    "folder_id": date_folder["id"],
                })
            else:
                kept += 1

    return {
        "retention_days": retention_days,
        "cutoff_date": cutoff.isoformat(),
        "scanned": scanned,
        "kept": kept,
        "trashed_count": len(trashed),
        "trashed": trashed,
        "dry_run": dry_run,
    }


def main(argv: list[str] | None = None) -> int:
    reg = config.load_registry()
    default_days = (
        (reg.get("storage") or {}).get("pipeline_raw_cache_retention_days") or 7
    )

    parser = argparse.ArgumentParser(prog="pipeline raw-cache-retention")
    parser.add_argument(
        "--days",
        type=int,
        default=default_days,
        help=f"keep date subfolders younger than this many days (default {default_days})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print what would be trashed without actually doing it",
    )
    args = parser.parse_args(argv)

    print(
        f"Pipeline Raw Cache retention: trash subfolders older than "
        f"{args.days} day(s)"
    )
    print("=" * 60)

    try:
        result = prune(retention_days=args.days, dry_run=args.dry_run)
    except Exception as e:
        print(f"FAIL: {e}")
        state.write_json(STATE_NAMESPACE, "run_status.json", {
            "source": STATE_NAMESPACE,
            "label": "Pipeline Raw Cache retention",
            "status": "failed",
            "detail": str(e),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        })
        return 1

    print()
    print(
        f"OK -- scanned {result['scanned']} date folder(s), "
        f"kept {result['kept']}, trashed {result['trashed_count']}"
        + (" (dry-run)" if args.dry_run else "")
    )

    state.write_json(STATE_NAMESPACE, "run_status.json", {
        "source": STATE_NAMESPACE,
        "label": "Pipeline Raw Cache retention",
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        **result,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
