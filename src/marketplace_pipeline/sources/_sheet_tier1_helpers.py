"""Shared helpers for the tier-1 Google-Sheet-backed sources.

Tier-1 means OWNED inventory: Snagged-owned (SNAP), Rob-owned, and
Snagged-brokered (Marketplace). The naming exercise gives these
preference but never excludes tier-2 results — high-quality tier-2
names still surface near the top. See sources.yaml header comment for
the exact query ordering.

The three sources (snagged_snap_sheet, rob_purchases_sheet,
snagged_marketplace_sheet) all follow the same pattern:

    1. Read a Google Sheet tab via the service account
    2. Filter to "active / still owned" rows per the sheet's convention
    3. Pull domain + price out of the configured columns
    4. Apply the universe filter (3-14 chars, dictionary words, etc.)
    5. Direct-upsert to Supabase with source_tier=1

This module factors out the shared work so each source module is just
the column-mapping config + a run() that calls process_sheet_tier1().
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .. import config, google_sheets_reader as gsr, state
from ..filters import universe as univ
from ..universe import supabase_writer

TRUTHY = {"yes", "y", "true", "1", "✓", "checked", "x"}


def parse_price(raw: str) -> float | None:
    """Strip $, commas, whitespace. 'TBD' / blank → None. Bad numbers → None."""
    raw = (raw or "").strip()
    if not raw or raw.upper() == "TBD":
        return None
    cleaned = raw.replace("$", "").replace(",", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None


def is_truthy(raw: str) -> bool:
    return (raw or "").strip().lower() in TRUTHY


def process_sheet_tier1(
    *,
    source_id: str,
    source_label: str,
    spreadsheet_id: str,
    tab_name: str,
    domain_col: str,
    price_col: str,
    active_col: str | None,
) -> int:
    """One-shot ingest for a tier-1 sheet-backed source.

    - Reads the tab
    - Filters by `active_col` if specified (only rows where it's truthy)
    - Applies universe filter to the domain
    - Pulls price from `price_col` (TBD / blank → None)
    - Upserts to Supabase with source_tier=1
    - Writes run_status.json

    Returns 0 on success (per pipeline CLI convention).
    """
    config.get_source(source_id)
    today = datetime.now(timezone.utc).date().isoformat()

    print(f"[1/3] Reading Google Sheet '{tab_name}' tab")
    rows = gsr.read_tab_as_dicts(spreadsheet_id, tab_name)
    print(f"      raw rows: {len(rows):,}")

    print("[2/3] Filtering: active/owned + universe")
    universe_entries: list[dict[str, Any]] = []
    skipped_inactive = 0
    skipped_bad_domain = 0
    skipped_filter = 0
    for row in rows:
        if active_col and not is_truthy(row.get(active_col, "")):
            skipped_inactive += 1
            continue
        domain = (row.get(domain_col) or "").strip().lower()
        if not domain or "." not in domain:
            skipped_bad_domain += 1
            continue
        if not univ.passes_universe_filter(domain):
            skipped_filter += 1
            continue
        universe_entries.append({
            "domain": domain,
            "price": parse_price(row.get(price_col) or ""),
        })
    print(
        f"      drops — inactive: {skipped_inactive} "
        f"bad_domain: {skipped_bad_domain} universe_filter: {skipped_filter}"
    )
    print(f"      universe entries: {len(universe_entries):,}")

    print("[3/3] Upserting to Supabase name_universe (tier=1)")
    stats = supabase_writer.upsert_from_source(
        source_id, universe_entries, today, source_tier=1,
    )
    if stats["status"] == "ok":
        print(f"      upserted {stats['rows_sent']:,} rows in {stats['batches']} batch(es)")
    else:
        print(f"      skipped: {stats.get('reason')}")

    state.write_json(source_id, "run_status.json", {
        "source": source_id,
        "label": source_label,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "raw_count": len(rows),
        "universe_count": len(universe_entries),
        "new_count": stats.get("rows_sent", 0),
        "supabase_status": stats.get("status"),
    })

    print("DONE")
    return 0
